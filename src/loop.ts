// The hourly loop: sync the backlog with live lanes, audit for missed work, start the next item
// that needs no decision, ask the lead the open questions, and record the run. It never merges,
// never pushes, never closes a pane and never edits a lane record. See docs/hourly-loop.md.
import { appendFileSync, copyFileSync, existsSync, linkSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { KEY_RE, Refusal, reservedKey, startLane, tellLead, type Deps } from "./harness.ts";
import type { Item, Lane, LoopRun } from "./store.ts";

export const HOUR = 3_600_000;
export const STALE_HOURS = 3;
export const READY_HOURS = 2;
export const REMIND_HOURS = 6;
export const MAX_ATTEMPTS = 2;
export const MEM_FREE_MIN_PCT = 10;

export type LoopOpts = { interval?: number; maxLanes?: number; maxStarts?: number; maxLoad?: number; force?: boolean };

// ---------- backlog ----------

function log(d: Deps, item: Item, kind: Item["log"][number]["kind"], text: string): void {
  const now = d.now();
  item.log.push({ at: now, kind, text });
  item.updatedAt = now;
  d.store.saveItem(item);
}

export function backlogAdd(
  d: Deps,
  id: string,
  briefFile: string,
  opts: { title?: string; priority?: number; cwd?: string; decision?: string; source?: string } = {},
): Item {
  if (!KEY_RE.test(id)) throw new Refusal(`item id must match ${KEY_RE} (it becomes the lane key)`);
  const reserved = reservedKey(id);
  if (reserved) throw new Refusal(reserved);
  const priority = opts.priority ?? 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9) throw new Refusal("--priority must be 1 (first) to 9 (last)");
  if (!existsSync(briefFile)) throw new Refusal(`no brief file ${briefFile}`);
  const old = d.store.item(id);
  if (old && (old.status === "open" || old.status === "running")) throw new Refusal(`item ${id} is already ${old.status}`);
  copyFileSync(briefFile, d.store.itemBrief(id));
  const now = d.now();
  const item: Item = {
    id, title: opts.title ?? id, brief: d.store.itemBrief(id), cwd: resolve(opts.cwd ?? process.cwd()), priority,
    status: "open", attempts: 0, createdAt: now, updatedAt: now, log: [],
    ...(opts.decision ? { decision: opts.decision } : {}),
    ...(opts.source ? { source: opts.source } : {}),
  };
  log(d, item, "add", opts.source ?? briefFile);
  return item;
}

function knownItem(d: Deps, id: string): Item {
  if (!KEY_RE.test(id)) throw new Refusal(`item id must match ${KEY_RE}`);
  const item = d.store.item(id);
  if (!item) throw new Refusal(`no backlog item ${id}`);
  return item;
}

function openItem(d: Deps, id: string): Item {
  const item = knownItem(d, id);
  if (item.status !== "open") throw new Refusal(`item ${id} is ${item.status}, not open`);
  return item;
}

/** Records the human's answer: clears the decision and appends the answer to the item's brief. */
export function backlogDecide(d: Deps, id: string, answer: string): void {
  if (!answer.trim()) throw new Refusal("decide needs the answer text");
  const item = openItem(d, id);
  appendFileSync(item.brief, `\n\nDecision on "${item.decision ?? "(none)"}": ${answer.trim()}\n`);
  delete item.decision;
  delete item.askedAt;
  delete item.remindedAt;
  item.attempts = 0;
  item.startFailures = 0;
  log(d, item, "decide", answer);
}

export function backlogDrop(d: Deps, id: string, why = "dropped"): void {
  const item = knownItem(d, id);
  if (item.status === "running") throw new Refusal(`item ${id} is running as a lane; close the lane first`);
  item.status = "dropped";
  log(d, item, "drop", why);
}

type Issue = { number: number; title: string; body: string; labels: { name: string }[] };

/** Open issues with a label become backlog items: label p1..p9 sets the priority, needs-decision marks a question. */
export const IMPORT_LIMIT = 1000;

/** A lane-key-safe id per source: `<repo>-<n>`, with a short hash of the full source when the slug had to be cut. */
export function importId(repo: string, n: number): string {
  const slug = repo.split("/")[1]!.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^[^a-z]+/, "") || "issue";
  const plain = `${slug}-${n}`;
  if (plain.length <= 41) return plain;
  const tag = `-${createHash("sha256").update(`${repo}#${n}`).digest("hex").slice(0, 6)}-${n}`;
  return `${slug.slice(0, 41 - tag.length).replace(/-+$/, "")}${tag}`;
}

export async function backlogImport(d: Deps, repo: string, label = "dori", cwd?: string): Promise<{ added: string[]; capped: boolean }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Refusal(`repo must look like owner/repo, got ${repo}`);
  const r = await d.exec("gh", ["issue", "list", "--repo", repo, "--label", label, "--state", "open", "--limit", String(IMPORT_LIMIT), "--json", "number,title,body,labels"]);
  if (r.code !== 0) throw new Error(`gh issue list failed: ${(r.stderr || r.stdout).trim()}`);
  const known = new Set(d.store.items().map((i) => i.source));
  const added: string[] = [];
  const issues = JSON.parse(r.stdout) as Issue[];
  for (const issue of issues) {
    const source = `${repo}#${issue.number}`;
    if (known.has(source)) continue;
    const names = issue.labels.map((l) => l.name);
    const p = names.map((n) => /^p([1-9])$/.exec(n)?.[1]).find(Boolean);
    const id = importId(repo, issue.number);
    const clash = d.store.item(id);
    if (clash && clash.source !== source) throw new Refusal(`import id ${id} for ${source} is already used by ${clash.source ?? "a hand-added item"}`);
    const brief = d.store.loopPath(`import-${id}.md`);
    writeFileSync(brief, `# ${issue.title}\n\nSource: https://github.com/${repo}/issues/${issue.number}\n\n${issue.body}\n`);
    backlogAdd(d, id, brief, {
      title: issue.title, cwd, source,
      ...(p ? { priority: Number(p) } : {}),
      ...(names.includes("needs-decision") ? { decision: `issue ${source} is labelled needs-decision: ${issue.title}` } : {}),
    });
    rmSync(brief, { force: true });
    added.push(id);
  }
  return { added, capped: issues.length >= IMPORT_LIMIT };
}

// ---------- lock ----------

type LockBody = { pid: number; at: number; nonce: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(path: string): LockBody | "missing" | "corrupt" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw e;
  }
  try {
    const v = JSON.parse(text) as Partial<LockBody>;
    return typeof v.pid === "number" && typeof v.nonce === "string" ? (v as LockBody) : "corrupt";
  } catch {
    return "corrupt";
  }
}

const sameLock = (a: LockBody | "missing" | "corrupt", b: LockBody | "missing" | "corrupt"): boolean =>
  typeof a === "string" || typeof b === "string" ? a === b : a.nonce === b.nonce;

/**
 * The lock is created whole with link(2), so it never exists half-written. A dead holder's (or corrupt) lock is
 * moved aside with rename(2), which only one process can win; if what was moved is not the lock judged stale, it
 * is linked back and this process backs off.
 */
function acquire(d: Deps): { nonce: string } | { holder: string } {
  const path = d.store.loopPath("lock");
  const nonce = randomUUID();
  const tmp = `${path}.${nonce}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: d.now(), nonce }));
  try {
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(tmp, path);
        return { nonce };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const seen = readLock(path);
      if (seen === "missing") continue;
      if (seen !== "corrupt" && alive(seen.pid)) return { holder: `locked by pid ${seen.pid}` };
      const aside = `${path}.stale.${nonce}`;
      try {
        renameSync(path, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      if (!sameLock(readLock(aside), seen)) {
        restore(aside, path);
        return { holder: "lock changed hands during takeover" };
      }
      rmSync(aside, { force: true });
    }
    return { holder: "lock contended" };
  } finally {
    rmSync(tmp, { force: true });
  }
}

const holds = (d: Deps, nonce: string): boolean => {
  const l = readLock(d.store.loopPath("lock"));
  return typeof l !== "string" && l.nonce === nonce;
};

function release(d: Deps, nonce: string): void {
  const path = d.store.loopPath("lock");
  const aside = `${path}.release.${nonce}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  const moved = readLock(aside);
  if (typeof moved === "string" || moved.nonce !== nonce) restore(aside, path);
  else rmSync(aside, { force: true });
}

/** Puts a lock that was moved by mistake back. If a newer lock took its place, the moved one is left aside, never deleted. */
export function restore(aside: string, path: string): void {
  try {
    linkSync(aside, path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return;
    throw e;
  }
  rmSync(aside, { force: true });
}

// ---------- one run ----------

const PR_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const hours = (ms: number): number => Math.floor(ms / HOUR);

async function ghState(d: Deps, kind: "pr" | "issue", repo: string, n: string): Promise<string> {
  const r = await d.exec("gh", [kind, "view", n, "--repo", repo, "--json", "state"]);
  if (r.code !== 0) throw new Error(`gh ${kind} view ${repo}#${n}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return String((JSON.parse(r.stdout) as { state?: string }).state);
}

async function sync(d: Deps, run: LoopRun): Promise<void> {
  for (const item of d.store.items()) {
    try {
      if (item.status === "running") {
        const lane = d.store.lane(item.id);
        if (lane?.status === "done") {
          item.status = "done";
          log(d, item, "done", "lane done");
          run.synced.push(`${item.id} done (lane done)`);
        } else if (!lane || lane.status === "lost") {
          const why = lane ? "lane lost" : "lane record missing";
          item.status = "open";
          item.attempts += 1;
          if (item.attempts >= MAX_ATTEMPTS) item.decision = `${why} ${item.attempts} times; retry, re-brief or drop?`;
          log(d, item, "reopen", `${why}, attempt ${item.attempts}`);
          run.synced.push(`${item.id} reopened (${why}, attempt ${item.attempts})`);
        } else if (lane.status === "ready") {
          const m = lane.final?.evidence.map((e) => PR_RE.exec(e)).find(Boolean);
          if (m && (await ghState(d, "pr", m[1]!, m[2]!)) === "MERGED") {
            item.status = "done";
            log(d, item, "done", "PR merged");
            run.synced.push(`${item.id} done (PR merged)`);
            run.findings.push(`${item.id} READY and its PR merged: dori done ${item.id}`);
          }
        }
      } else if (item.status === "open" && item.source) {
        const [repo, n] = item.source.split("#");
        if ((await ghState(d, "issue", repo!, n!)) === "CLOSED") {
          item.status = "dropped";
          log(d, item, "drop", "source issue closed");
          run.synced.push(`${item.id} dropped (${item.source} closed)`);
        }
      }
    } catch (e) {
      run.findings.push(`gh: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The last time the lane itself said something (start or report). Pane polling by the duty loop does not count. */
const lastReport = (lane: Lane): number =>
  Math.max(lane.createdAt, ...lane.log.filter((e) => e.kind === "start" || e.kind === "report").map((e) => e.at));

async function audit(d: Deps, run: LoopRun): Promise<void> {
  const now = d.now();
  for (const lane of d.store.lanes()) {
    if (lane.status !== "working" && lane.status !== "waiting" && lane.status !== "ready") continue;
    let st;
    try {
      st = await d.herdr.status(lane.paneId);
    } catch (e) {
      run.findings.push(`herdr: ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (st === "gone") {
      run.findings.push(`${lane.key} pane ${lane.paneId} is gone`);
    } else if (lane.status === "ready") {
      const age = now - (lane.final?.at ?? lane.lastActivityAt);
      if (age >= READY_HOURS * HOUR) run.findings.push(`${lane.key} READY ${hours(age)}h ago, not closed: dori done ${lane.key}`);
    } else if (now - lastReport(lane) >= STALE_HOURS * HOUR) {
      const age = hours(now - lastReport(lane));
      run.findings.push(lane.status === "waiting"
        ? `${lane.key} waiting ${age}h on: ${lane.log.at(-1)?.text.slice(0, 80) ?? "?"}`
        : `${lane.key} working, no report for ${age}h`);
    }
  }
}

const isOpenLane = (status: string): boolean => status !== "done" && status !== "lost";

async function pull(d: Deps, run: LoopRun, maxLanes: number, maxStarts: number, maxLoad: number | undefined, nonce: string): Promise<void> {
  if (!d.store.roles().lead) {
    run.held.push("no lead pane registered");
    return;
  }
  const host = d.host();
  const open = d.store.lanes().filter((l) => isOpenLane(l.status)).length;
  let starts = Math.max(0, Math.min(maxLanes - open, maxStarts));
  const candidates = d.store.items()
    .filter((i) => i.status === "open" && !i.decision && !isOpenLane(d.store.lane(i.id)?.status ?? "done"))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (candidates.length > 0 && (host.load1 > (maxLoad ?? host.cores) || host.memFreePct < MEM_FREE_MIN_PCT)) {
    run.held.push(`host busy: load ${host.load1.toFixed(1)} (limit ${maxLoad ?? host.cores}), mem free ${host.memFreePct}%`);
    starts = 0;
  }
  // Each start attempt uses one of this run's slots, so a broken host costs at most `starts` failures per run.
  // A failed item counts toward MAX_ATTEMPTS and then becomes a question, so it never blocks the items behind it.
  let tried = 0;
  for (; tried < Math.min(starts, candidates.length); tried++) {
    const item = candidates[tried]!;
    if (!holds(d, nonce)) {
      run.held.push("lock lost to another loop; no more starts this run");
      break;
    }
    try {
      await startLane(d, item.id, item.brief, { cwd: item.cwd });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const lane = d.store.lane(item.id);
      if (!lane || !isOpenLane(lane.status) || lane.createdAt < run.at) {
        item.startFailures = (item.startFailures ?? 0) + 1;
        if (item.startFailures >= MAX_ATTEMPTS) item.decision = `lane start failed ${item.startFailures} times (${why.slice(0, 120)}); fix the brief or cwd, or drop?`;
        log(d, item, "start", `failed: ${why}`);
        run.findings.push(`start ${item.id} failed: ${why}`);
        continue;
      }
      run.findings.push(`${item.id} started in ${lane.paneId} but the lead was not told: ${why}`);
    }
    item.status = "running";
    log(d, item, "start", "lane opened by the hourly loop");
    run.started.push(`${item.id} (p${item.priority})`);
  }
  const waiting = candidates.length - tried;
  if (waiting > 0) {
    run.held.push(`${waiting} item(s) waiting: ${Math.max(0, maxLanes - open - run.started.length)} free of ${maxLanes} lanes, max ${maxStarts}/run`);
  }
}

function ask(d: Deps, run: LoopRun): void {
  const now = d.now();
  for (const item of d.store.items()) {
    if (item.status !== "open" || !item.decision) continue;
    const line = `[DECIDE ${item.id}] ${item.decision} -> dori backlog decide ${item.id} --text '...' | dori backlog drop ${item.id}`;
    if (item.askedAt === undefined) {
      item.askedAt = now;
      log(d, item, "ask", item.decision);
      run.asked.push(line);
    } else if (item.remindedAt === undefined && now - item.askedAt >= REMIND_HOURS * HOUR) {
      item.remindedAt = now;
      log(d, item, "remind", item.decision);
      run.asked.push(`(reminder) ${line}`);
    }
  }
}

export function summary(run: LoopRun): string {
  if (run.skipped) return `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] skipped: ${run.skipped}`;
  const s = run.status!;
  const lines = [
    `[LOOP ${new Date(run.at).toISOString().slice(0, 16)}Z] lanes ${s.lanes}/${s.maxLanes}${s.adhoc.length ? ` (not from backlog: ${s.adhoc.join(", ")})` : ""}` +
      ` | items open ${s.items.open} (decide ${s.items.decide}) running ${s.items.running}` +
      ` | load ${s.host.load1.toFixed(1)}/${s.host.cores} mem-free ${s.host.memFreePct}%`,
  ];
  for (const k of ["synced", "findings", "started", "held"] as const) if (run[k].length) lines.push(`${k}: ${run[k].join("; ")}`);
  lines.push(...run.asked);
  return lines.join("\n");
}

/** One hourly pass. Skipped runs (stopped, locked, too soon) change nothing and write nothing. */
export async function loopTick(d: Deps, opts: LoopOpts = {}): Promise<LoopRun> {
  const interval = opts.interval ?? HOUR;
  const maxLanes = opts.maxLanes ?? 3;
  const maxStarts = opts.maxStarts ?? 2;
  const empty = { synced: [], findings: [], started: [], held: [], asked: [] };
  const stop = d.store.stop();
  if (stop) return { at: d.now(), skipped: `stopped: ${stop.reason}`, ...empty };
  const lock = acquire(d);
  if ("holder" in lock) return { at: d.now(), skipped: lock.holder, ...empty };
  try {
    const last = d.store.lastRun();
    if (last && !opts.force && d.now() - last.at < interval) {
      return { at: d.now(), skipped: `ran ${Math.floor((d.now() - last.at) / 60_000)}m ago`, ...empty };
    }
    const run: LoopRun = { at: d.now(), synced: [], findings: [], started: [], held: [], asked: [] };
    await sync(d, run);
    await audit(d, run);
    await pull(d, run, maxLanes, maxStarts, opts.maxLoad, lock.nonce);
    ask(d, run);
    const items = d.store.items();
    const running = new Set(items.filter((i) => i.status === "running").map((i) => i.id));
    const lanes = d.store.lanes().filter((l) => isOpenLane(l.status));
    run.status = {
      lanes: lanes.length,
      maxLanes,
      adhoc: lanes.filter((l) => !running.has(l.key)).map((l) => l.key),
      items: {
        open: items.filter((i) => i.status === "open").length,
        decide: items.filter((i) => i.status === "open" && i.decision).length,
        running: running.size,
      },
      host: d.host(),
    };
    const record = d.store.saveRun(run);
    try {
      await tellLead(d, summary(run), "loop");
    } catch (e) {
      run.findings.push(`report to the lead failed: ${e instanceof Error ? e.message : String(e)}`);
      d.store.saveRun(run, record);
    }
    return run;
  } finally {
    release(d, lock.nonce);
  }
}

/**
 * How long to sleep: until the last stamp's next hour when that is still ahead (so runs keep their cadence after a
 * restart), otherwise a full interval. A stopped, locked-out or failing loop writes no stamp, so it waits an interval
 * between checks instead of spinning.
 */
export function msUntilNext(d: Deps, interval: number): number {
  const last = d.store.lastRun();
  const due = last ? last.at + interval - d.now() : 0;
  return due > 0 ? Math.max(1000, due) : interval;
}
