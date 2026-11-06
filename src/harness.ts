import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { DeliveryUncertain, Herdr, HerdrError, omoScreenIdle, shq, spawnExec, type AgentStatus, type Exec } from "./herdr.ts";
import { KEY_RE, reservedKey, Store, type DeliveryAttempt, type HostLoad, type Lane, type QueuedMessage, type Role } from "./store.ts";
import { Telemetry, type MergeOutcome, type Usage } from "./telemetry.ts";

export { KEY_RE, reservedKey };

export const NUDGE_MINUTES = [10, 20, 40] as const;
const PROMPTS = join(import.meta.dir, "..", "prompts");
const CLI = resolve(import.meta.dir, "cli.ts");

export type Deps = {
  readonly store: Store;
  readonly herdr: Herdr;
  readonly exec: Exec;
  readonly now: () => number;
  readonly agentCmd: string;
  readonly doriCmd: string;
  readonly host: () => HostLoad;
  readonly usage: Usage;
};

export const defaultDeps = (): Deps => {
  const store = new Store();
  return {
    store,
    herdr: new Herdr(),
    exec: spawnExec,
    now: Date.now,
    agentCmd: process.env["DORI_AGENT_CMD"] ?? "omo",
    doriCmd: process.env["DORI_CMD"] ?? `DORI_HOME=${shq(store.root)} bun ${shq(CLI)}`,
    host: () => ({ load1: loadavg()[0] ?? 0, cores: cpus().length, memFreePct: memFreePct() }),
    usage: new Telemetry(store.root),
  };
};

export class Refusal extends Error {}

const sysctlMemoryLevel = (): string => execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 });

/**
 * Percent of memory available to start new work. On Linux, os.freemem() is MemAvailable. On macOS it is only the
 * truly free pages (inactive and cached pages excluded), which sits near 0-5% on a healthy Mac, so the kernel's own
 * available-memory level (the figure behind Activity Monitor's memory pressure) is used there instead.
 */
export function memFreePct(
  platform: string = process.platform,
  readLevel: () => string = sysctlMemoryLevel,
  freePct: () => number = () => Math.round((freemem() / totalmem()) * 100),
): number {
  if (platform === "darwin") {
    try {
      const level = Number(readLevel().trim());
      if (Number.isFinite(level) && level >= 0 && level <= 100) return Math.round(level);
    } catch {
      // fall through to freemem(): a missing sysctl must not stop the loop from reading memory at all
    }
  }
  return freePct();
}

const prompt = (name: string, vars: Record<string, string>): string =>
  readFileSync(join(PROMPTS, name), "utf8").replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? `{{${k}}}`);

// ---------- pane messaging ----------

export function resolveTarget(d: Deps, target: string): string {
  if (/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/.test(target)) return target;
  const roles = d.store.roles();
  if (target === "lead" || target === "duty") {
    const pane = roles[target];
    if (!pane) throw new Refusal(`no ${target} pane registered (dori role ${target} <pane>)`);
    return pane;
  }
  const lane = d.store.lane(target);
  if (lane && lane.status !== "done") return lane.paneId;
  throw new Refusal(`unknown target ${target}: not a pane id, role or open lane`);
}

// A pane with no running agent (`shell`) is never ready: text typed into a bare shell runs as a command (#66).
const READY_TO_READ: readonly AgentStatus[] = ["idle", "done"];

export type SendResult = "DELIVERED" | "QUEUED" | "HELD";

/**
 * Delivers now when the pane can read; otherwise queues it for the duty loop (busy agents are never interrupted).
 * The command-line path: an uncertain delivery is a result, never an error (see settled).
 */
export async function send(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  return settled(sendOrThrow(d, target, text, from));
}

/** send for the duty and hourly loops: throws DeliveryUncertain, having recorded it, so they report the failure. */
async function sendOrThrow(d: Deps, target: string, text: string, from: string): Promise<"DELIVERED" | "QUEUED"> {
  const paneId = resolveTarget(d, target);
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return (await flushInbox(d, paneId)) === "delivered" ? "DELIVERED" : "QUEUED";
}

/**
 * An uncertain delivery is already recorded on the queued message (#89), so on the command-line path it is a result:
 * a sender who saw a failure would send again. `HELD`: it may or may not have reached the pane and is not resent.
 * `QUEUED`: typed text that only waits for its Enter.
 */
async function settled<T extends SendResult | undefined>(delivery: Promise<T>): Promise<T | "QUEUED" | "HELD"> {
  try {
    return await delivery;
  } catch (e) {
    if (e instanceof DeliveryUncertain) return e.typed ? "QUEUED" : "HELD";
    throw e;
  }
}

/**
 * `dori send --to-shell`: the operator's per-message opt-in to type this one message into a pane with no agent.
 * Only the CLI flag reaches here, never relayed content, and queued messages are never typed with it. If an agent
 * is in the pane, or appears before typing, the message takes the queued agent path instead.
 */
export async function sendToShell(d: Deps, target: string, text: string, from: string): Promise<SendResult> {
  const paneId = resolveTarget(d, target);
  if ((await d.herdr.status(paneId)) !== "shell") return send(d, target, text, from);
  if (await d.herdr.typeIntoShell(paneId, text)) return "DELIVERED";
  d.store.enqueue(paneId, { at: d.now(), from, text });
  return "QUEUED";
}

/**
 * Delivers a pane's queued messages as one batch. `held`: only messages held after an ambiguous delivery are left;
 * they wait for a person or the lead (#89). `queued` also when another flush of this pane holds its inbox lock: one
 * flush per pane at a time, across processes (#108). Throws DeliveryUncertain, having recorded the attempt on the
 * queued messages, when the batch may already have reached the pane, and Refusal when the pane is gone.
 */
export async function flushInbox(d: Deps, paneId: string): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  if (d.store.queued(paneId).length === 0) return "delivered";
  const release = d.store.lockInbox(paneId, d.now());
  if (!release) return "queued";
  try {
    return await flushLocked(d, paneId);
  } finally {
    release();
  }
}

async function flushLocked(d: Deps, paneId: string): Promise<"delivered" | "queued" | "no-agent" | "held"> {
  // Re-read under the lock: the flush that held it may have delivered these meanwhile.
  const all = d.store.queued(paneId);
  if (all.length === 0) return "delivered";
  const queued = all.filter((m) => m.attempt?.state !== "ambiguous");
  let status = await d.herdr.status(paneId);
  // Before the held check, so a gone pane with only held messages says so instead of delivery-ambiguous forever (#108).
  if (status === "gone") throw new Refusal(`pane ${paneId} is gone; ${all.length} message(s) kept in its inbox`);
  if (queued.length === 0) return "held";
  if (status === "working" && (await screenShowsIdle(d, paneId))) status = "idle";
  const typed = queued.filter((m) => m.attempt?.state === "typed");
  if (status === "shell") {
    // The agent the text was typed into is gone from the pane: an Enter later would go to another agent's empty input.
    if (typed.length > 0) await holdTyped(d, paneId, typed, "the agent left the pane before its Enter");
    return "no-agent";
  }
  if (!READY_TO_READ.includes(status)) return "queued";
  if (typed.length > 0) {
    // An earlier pass typed these and only the Enter failed: press Enter, never type them again (#89), and only into
    // the agent they were typed into (#108).
    const submitted = await d.herdr.submitTyped(paneId, typed[0]!.attempt);
    if (submitted === "wait") return "no-agent";
    if (submitted === "changed") {
      await holdTyped(d, paneId, typed, "a different agent is in the pane than the one the text was typed into");
      return typed.length === queued.length ? "held" : "queued";
    }
    settleInbox(d, paneId, typed);
    // Messages queued after the typed batch were not delivered by this Enter; they wait for the next pass.
    return typed.length === queued.length ? "delivered" : "queued";
  }
  const body =
    queued.length === 1
      ? queued[0]!.text
      : `${queued.length} messages arrived while you were busy:\n\n` +
        queued.map((m, i) => `(${i + 1}) from ${m.from}:\n${m.text}`).join("\n\n");
  try {
    if (!(await d.herdr.deliver(paneId, body))) return "no-agent";
  } catch (e) {
    if (e instanceof DeliveryUncertain) await recordUncertain(d, paneId, queued, e);
    throw e;
  }
  settleInbox(d, paneId, queued);
  return "delivered";
}

/** Re-reads the inbox and drops the batch (delivered) or marks it with the failed attempt; messages queued meanwhile stay. */
function settleInbox(d: Deps, paneId: string, batch: readonly QueuedMessage[], attempt?: DeliveryAttempt): void {
  const left = [...batch];
  const rest = d.store.queued(paneId).flatMap((m) => {
    const i = left.findIndex((b) => b.at === m.at && b.from === m.from && b.text === m.text);
    if (i < 0) return [m];
    left.splice(i, 1);
    return attempt ? [{ ...m, attempt }] : [];
  });
  d.store.saveInbox(paneId, rest);
}

const NOTICE_FROM = "dori-delivery";

/**
 * Records an uncertain delivery on the queued messages. Typed text only waits for its Enter. An ambiguous batch is
 * held and the lead is told once; held messages are never retried, so the notice is never repeated. A notice that
 * itself fails ambiguously is held without another notice, so this cannot loop.
 */
async function recordUncertain(d: Deps, paneId: string, batch: readonly QueuedMessage[], e: DeliveryUncertain): Promise<void> {
  const detail = failureDetail(e);
  settleInbox(d, paneId, batch, { at: d.now(), state: e.typed ? "typed" : "ambiguous", detail, ...(e.typed ? e.agent : {}) });
  if (!e.typed) await noticeHeld(d, paneId, batch, `herdr said: ${detail}`);
}

/** Typed text whose agent left or changed (#108): it may sit in a lost input, so it is held like an ambiguous batch. */
async function holdTyped(d: Deps, paneId: string, typed: readonly QueuedMessage[], why: string): Promise<void> {
  settleInbox(d, paneId, typed, { at: d.now(), state: "ambiguous", detail: why });
  await noticeHeld(d, paneId, typed, why);
}

async function noticeHeld(d: Deps, paneId: string, batch: readonly QueuedMessage[], why: string): Promise<void> {
  if (batch.every((m) => m.from === NOTICE_FROM)) return;
  const which = batch.map((m) => `from ${m.from} queued ${new Date(m.at).toISOString()}`).join(", ");
  const text =
    `[DELIVERY-AMBIGUOUS ${paneId}] ${batch.length} message(s) (${which}) may or may not have reached the pane; ${why}. ` +
    `Held and not resent. Check the pane and see dori inbox list ${paneId}: if it did not arrive, dori inbox resend ${paneId} <index>; if it did, dori inbox ack ${paneId} <index>.`;
  try {
    await tellLead(d, text, NOTICE_FROM);
  } catch (err) {
    process.stderr.write(`dori: telling the lead about the ambiguous delivery to ${paneId} failed too (${failureDetail(err)}); the notice is kept in the lead's inbox\n`);
  }
}

// ---------- held entries (#108) ----------

export type InboxEntry = { index: number; state: "queued" | "typed" | "held"; from: string; at: number; preview: string };

const PREVIEW_CHARS = 60;

/** A pane's queued messages, 1-based in inbox order. The text is never shown whole: its first 60 characters, JSON-escaped. */
export function inboxList(d: Deps, target: string): { paneId: string; entries: InboxEntry[] } {
  const paneId = resolveTarget(d, target);
  const entries = d.store.queued(paneId).map((m, i): InboxEntry => ({
    index: i + 1,
    state: m.attempt?.state === "ambiguous" ? "held" : m.attempt?.state === "typed" ? "typed" : "queued",
    from: m.from,
    at: m.at,
    preview: JSON.stringify(m.text.slice(0, PREVIEW_CHARS)) + (m.text.length > PREVIEW_CHARS ? "..." : ""),
  }));
  return { paneId, entries };
}

/**
 * `ack` drops a held entry (it did arrive); `resend` clears its attempt so the next flush delivers it (it did not).
 * Only held entries: a typed one is in the pane's input already, and a queued one is delivered anyway. Runs under the
 * inbox lock, so a flush in progress cannot overwrite the change.
 */
export function releaseHeld(d: Deps, target: string, index: number, how: "ack" | "resend"): string {
  const paneId = resolveTarget(d, target);
  const release = d.store.lockInbox(paneId, d.now());
  if (!release) throw new Refusal(`the inbox of ${paneId} is being flushed right now; try again`);
  try {
    const msgs = d.store.queued(paneId);
    const m = Number.isInteger(index) ? msgs[index - 1] : undefined;
    if (!m) throw new Refusal(`no entry ${index} in the inbox of ${paneId} (${msgs.length} entries; see dori inbox list ${target})`);
    if (m.attempt?.state !== "ambiguous") throw new Refusal(`entry ${index} of ${paneId} is not held; only held entries can be acked or resent`);
    const { attempt: _, ...fresh } = m;
    d.store.saveInbox(paneId, how === "ack" ? msgs.filter((_, i) => i !== index - 1) : msgs.map((x, i) => (i === index - 1 ? fresh : x)));
    return paneId;
  } finally {
    release();
  }
}

/**
 * herdr reports an omo with live monitors as `working` between turns (#62). Believe the screen only when it
 * positively shows the idle input; a failed read is doubt, so the message stays queued for the next duty pass.
 */
async function screenShowsIdle(d: Deps, paneId: string): Promise<boolean> {
  try {
    return omoScreenIdle(await d.herdr.read(paneId, 30));
  } catch {
    return false;
  }
}

/** The lead delivery's result, or undefined when no lead is registered. Throws DeliveryUncertain like sendOrThrow. */
export async function tellLead(d: Deps, text: string, from: string): Promise<"DELIVERED" | "QUEUED" | undefined> {
  if (!d.store.roles().lead) {
    process.stderr.write(`dori: no lead pane registered; message kept only in the lane log\n`);
    return undefined;
  }
  return sendOrThrow(d, "lead", text, from);
}

// ---------- lanes ----------

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; workspace?: string } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost") throw new Refusal(`lane ${key} is already open in ${existing.paneId}`);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  const workspace = opts.workspace ?? process.env["HERDR_WORKSPACE_ID"];
  const env = { DORI_LANE: key, DORI_HOME: d.store.root };
  const pane = workspace
    ? await d.herdr.createTab(key, cwd, workspace, env)
    : await d.herdr.createTab(key, cwd, (await d.herdr.createWorkspace("dori", cwd)).workspaceId, env);
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  await d.herdr.run(pane.paneId, `${d.agentCmd} ${shq(kickoff)}`);

  const now = d.now();
  const lane: Lane = {
    key, paneId: pane.paneId, tabId: pane.tabId, brief: briefPath, cwd,
    status: "working", createdAt: now, lastActivityAt: now, nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${pane.paneId}`, key);
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

export async function report(d: Deps, key: string, text: string, status?: "working" | "waiting"): Promise<SendResult | undefined> {
  const lane = openLane(d, key);
  const now = d.now();
  lane.log.push({ at: now, kind: "report", text });
  lane.lastActivityAt = now;
  lane.nudges = 0;
  if (status) lane.status = status;
  d.store.saveLane(lane);
  return settled(tellLead(d, `[REPORT ${key}${status === "waiting" ? " WAITING" : ""}] ${text}`, key));
}

export async function ready(d: Deps, key: string, text: string, evidence: readonly string[]): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  const sent = await settled(tellLead(d, `[READY ${key}] ${text}\nevidence: ${evidence.join(" ")}`, key));
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
  return sent;
}

export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const st = await d.herdr.status(lane.paneId);
  if (st === "working" || st === "blocked") throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await d.herdr.close(lane.paneId);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  d.store.saveLane(lane);
}

// ---------- duty loop ----------

export type DutyEvent = { lane?: string; pane?: string; action: string; detail?: string };

/** A short one-line reason. A HerdrError message carries the whole argv (the queued text), so use herdr's own output. */
function failureDetail(e: unknown): string {
  if (e instanceof DeliveryUncertain) e = e.failure;
  const raw = e instanceof HerdrError ? e.result.stderr || e.result.stdout : e instanceof Error ? e.message : String(e);
  const first = raw.trim().split("\n")[0] ?? "";
  return first.length > 200 ? `${first.slice(0, 200)}...` : first;
}

/** One proactive pass: flush inboxes of panes that became idle, nudge silent lanes, escalate, detect lost panes. */
export async function dutyTick(d: Deps): Promise<DutyEvent[]> {
  // Kill switch: a stopped duty loop delivers, nudges and escalates nothing. Queued messages wait for the resume.
  const stop = d.store.stop("duty");
  if (stop) return [{ action: "stopped", detail: stop.reason }];
  const events: DutyEvent[] = [];
  for (const paneId of d.store.inboxPanes()) {
    try {
      const result = await flushInbox(d, paneId);
      if (result === "delivered") events.push({ pane: paneId, action: "flushed" });
      if (result === "no-agent") {
        events.push({ pane: paneId, action: "inbox-held", detail: `no agent in front; ${d.store.queued(paneId).length} message(s) kept` });
      }
      // Held after an ambiguous delivery (#89): shown on every pass, resent never; the lead was told once.
      const held = d.store.queued(paneId).filter((m) => m.attempt?.state === "ambiguous").length;
      if (held > 0) events.push({ pane: paneId, action: "delivery-ambiguous", detail: `${held} message(s) held, not resent` });
    } catch (e) {
      // One pane's failed delivery must never kill the loop for every other pane and lane.
      if (e instanceof Refusal) events.push({ pane: paneId, action: "inbox-target-gone" });
      else if (e instanceof DeliveryUncertain && !e.typed) events.push({ pane: paneId, action: "delivery-ambiguous", detail: failureDetail(e) });
      else events.push({ pane: paneId, action: "flush-failed", detail: failureDetail(e) });
    }
  }
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting") continue;
    try {
      const st = await d.herdr.status(lane.paneId);
      const now = d.now();
      if (st === "gone") {
        lane.status = "lost";
        lane.log.push({ at: now, kind: "lost", text: "pane disappeared without READY" });
        d.store.saveLane(lane);
        await tellLead(d, `[LOST ${lane.key}] pane ${lane.paneId} closed without a final answer`, "duty");
        events.push({ lane: lane.key, action: "lost" });
        continue;
      }
      if (st === "working") {
        lane.lastActivityAt = now;
        d.store.saveLane(lane);
        continue;
      }
      if (lane.status === "waiting" || st === "blocked") continue;
      const idleMin = (now - lane.lastActivityAt) / 60_000;
      const due = NUDGE_MINUTES[lane.nudges];
      if (due === undefined || idleMin < due) continue;
      lane.nudges += 1;
      lane.log.push({ at: now, kind: "nudge", text: `idle ${Math.floor(idleMin)} min` });
      d.store.saveLane(lane);
      if (lane.nudges < NUDGE_MINUTES.length) {
        await sendOrThrow(d, lane.key, prompt("nudge.md", { key: lane.key, minutes: String(Math.floor(idleMin)), dori: d.doriCmd }), "duty");
        events.push({ lane: lane.key, action: `nudge-${lane.nudges}` });
      } else {
        await tellLead(d, `[ESCALATE ${lane.key}] idle ${Math.floor(idleMin)} min with no READY after ${lane.nudges - 1} nudges`, "duty");
        events.push({ lane: lane.key, action: "escalated" });
      }
    } catch (e) {
      // One lane's failed status read or delivery must not end the loop for the other lanes.
      events.push({ lane: lane.key, action: "lane-failed", detail: failureDetail(e) });
    }
  }
  const count = (pred: (a: string) => boolean) => events.filter((e) => pred(e.action)).length;
  d.usage.touch();
  d.usage.duty({
    ticks: 1,
    flushed: count((a) => a === "flushed"),
    nudges: count((a) => a.startsWith("nudge-")),
    escalations: count((a) => a === "escalated"),
    lost: count((a) => a === "lost"),
  });
  return events;
}

// ---------- review + merge gate ----------

export type PrRef = { repo: string; number: number; id: string };

export function parsePr(s: string): PrRef {
  const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(s);
  if (!m) throw new Refusal(`PR must look like owner/repo#123, got ${s}`);
  return { repo: m[1]!, number: Number(m[2]), id: s };
}

async function gh(d: Deps, argv: readonly string[]): Promise<string> {
  const r = await d.exec("gh", argv);
  if (r.code !== 0) throw new Error(`gh ${argv.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export async function headSha(d: Deps, pr: PrRef): Promise<string> {
  const out = JSON.parse(await gh(d, ["pr", "view", String(pr.number), "--repo", pr.repo, "--json", "headRefOid"]));
  return String(out.headRefOid);
}

/** Runs a fresh, non-interactive reviewer session pinned to the PR head and records its verdict as a receipt. */
export async function review(d: Deps, prId: string, model?: string): Promise<{ verdict: "CLEAR" | "BLOCK"; sha: string }> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const text = prompt("review.md", { pr: pr.id, repo: pr.repo, number: String(pr.number), sha });
  const argv = ["-p", "--no-session", ...(model ? ["--model", model] : []), text];
  const res = await d.exec(d.agentCmd, argv);
  if (res.code !== 0) throw new Error(`reviewer exited ${res.code}: ${res.stderr.trim()}`);
  const verdicts = [...res.stdout.matchAll(/^VERDICT:\s*(CLEAR|BLOCK)\b/gm)];
  const last = verdicts.at(-1);
  if (!last) throw new Error("reviewer printed no VERDICT line; no receipt written");
  const verdict = last[1] as "CLEAR" | "BLOCK";
  d.store.saveReceipt({ pr: pr.id, sha, verdict, model: model ?? "default", at: d.now(), summary: res.stdout.trim().slice(-4000) });
  d.usage.record({ name: "dori.review_completed", verdict });
  return { verdict, sha };
}

type Check = { name: string; bucket: string };

/** Merge only when the exact current head has a CLEAR review receipt and every check passed. An empty check list is never green. */
export async function mergeGate(d: Deps, prId: string, opts: { dryRun?: boolean } = {}): Promise<string> {
  const pr = parsePr(prId);
  const sha = await headSha(d, pr);
  const refused = await gateRefusal(d, pr, sha);
  if (refused) {
    if (!opts.dryRun) d.usage.record({ name: "dori.merge_decided", outcome: refused[0] });
    throw new Refusal(`MERGE_REFUSED ${refused[1]}`);
  }
  if (opts.dryRun) return `MERGE_OK ${pr.id} head=${sha} (dry run)`;
  await gh(d, ["pr", "merge", String(pr.number), "--repo", pr.repo, "--squash", "--match-head-commit", sha]);
  d.usage.record({ name: "dori.merge_decided", outcome: "merged" });
  return `MERGED ${pr.id} head=${sha}`;
}

async function gateRefusal(d: Deps, pr: PrRef, sha: string): Promise<[MergeOutcome, string] | undefined> {
  const receipt = d.store.receipt(pr.id, sha);
  if (!receipt) return ["no_receipt", `no review receipt at head ${sha.slice(0, 12)} (run: dori review ${pr.id})`];
  if (receipt.verdict !== "CLEAR") return ["review_block", `review at ${sha.slice(0, 12)} is ${receipt.verdict}`];
  const checksRes = await d.exec("gh", ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,bucket"]);
  const checks: Check[] = checksRes.stdout.trim().startsWith("[") ? JSON.parse(checksRes.stdout) : [];
  if (checks.length === 0) return ["no_checks", "no checks reported: an empty check list is never green"];
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping");
  if (bad.length > 0) return ["checks_red", `checks not green: ${bad.map((c) => `${c.name}=${c.bucket}`).join(", ")}`];
  if (!checks.some((c) => c.bucket === "pass")) return ["checks_all_skipped", "every check was skipped"];
  return undefined;
}

export const ROLES: readonly Role[] = ["lead", "duty"];
