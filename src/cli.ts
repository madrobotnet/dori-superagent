#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  defaultDeps, done, dutyTick, inboxList, mergeGate, ready, Refusal, releaseHeld, report, review, send, sendToShell, startLane, ROLES,
  type Deps, type SendResult,
} from "./harness.ts";
import { shq } from "./herdr.ts";
import { backlogAdd, backlogDecide, backlogDrop, backlogImport, loopTick, msUntilNext, summary, HOUR, IMPORT_LIMIT } from "./loop.ts";
import type { Role } from "./store.ts";

const USAGE = `dori - a proactive multi-session harness on herdr + omo

  dori up [--cwd DIR]                         open lead, duty, duty loop and hourly loop panes
  dori role <lead|duty> [PANE]                register a pane as lead or duty (default: this pane)
  dori start <key> --brief FILE [--cwd DIR]   open a lane: new tab, omo session, brief + lane rules
  dori report <key> --text T [--status working|waiting]
  dori ready <key> --text T --evidence LINK [--evidence LINK ...]
  dori send <lead|duty|key|pane> --text T     deliver now, or queue until the pane's agent is idle
                  [--to-shell]                operator only: type this one message into a pane with no agent
  dori inbox list <pane|role|key>             queued entries: index, state (queued|typed|held), sender, time, first 60 chars
  dori inbox ack <pane|role|key> <index>      drop a held entry: it did reach the pane
  dori inbox resend <pane|role|key> <index>   release a held entry: the next flush delivers it
  dori duty [--once] [--interval SECONDS]     flush inboxes, nudge idle lanes, escalate, detect lost lanes
  dori duty stop [--text WHY] | resume | status   kill switch
  dori loop [--once] [--interval S] [--max-lanes N] [--max-starts N] [--max-load L] [--force]
                                              hourly: sync backlog, audit missed work, start the next item, ask decisions
  dori loop stop [--text WHY] | resume | status   kill switch and last run
  dori backlog add <id> --brief FILE [--title T] [--priority 1-9] [--cwd DIR] [--decision Q]
  dori backlog list | decide <id> --text ANSWER | drop <id> [--text WHY]
  dori backlog import <owner/repo> [--label dori] [--cwd DIR]   open labelled issues -> items
  dori review <owner/repo#N> [--model M]      fresh omo reviewer at the exact head -> receipt
  dori merge <owner/repo#N> [--dry-run]       CLEAR receipt at head + green checks -> squash merge
  dori done <key>                             lead closes a READY lane
  dori status

--text may be omitted to read the message from stdin.
send, report and ready exit 3 and print HELD <target> when the delivery may or may not have reached the pane:
it is held and never resent, so do not send it again: check the pane, then dori inbox ack or dori inbox resend it.
QUEUED (exit 0) means it waits in the pane's inbox.`;

const COMMANDS = new Set(["up", "role", "start", "report", "ready", "send", "inbox", "duty", "review", "merge", "done", "status", "loop", "backlog"]);

type Args = { pos: string[]; flags: Map<string, string[]> };

// Flags that never take a value. Every other flag takes the next argument verbatim, even one starting with "--", so a
// relayed value such as `--from "$SENDER"` or `--text "$MSG"` can never turn into a flag like --to-shell (#66).
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["once", "force", "dry-run", "to-shell"]);

function parse(argv: readonly string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    const value = BOOLEAN_FLAGS.has(name) || next === undefined ? "true" : (i++, next);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  return { pos, flags };
}

const one = (a: Args, f: string): string | undefined => a.flags.get(f)?.at(-1);
const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Refusal(`missing ${what}\n\n${USAGE}`);
  return v;
};

async function textOf(a: Args): Promise<string> {
  const t = one(a, "text");
  if (t !== undefined) return t;
  if (process.stdin.isTTY) throw new Refusal("give --text or pipe the message on stdin");
  return (await Bun.stdin.text()).trim();
}

/** Prints the line for a delivery that did not land now and returns the exit code: HELD 3, everything else 0. */
function deliveryOutcome(result: SendResult | undefined, target: string): number {
  if (result === "HELD") {
    console.log(`HELD ${target}: delivery may or may not have reached the pane; do not resend`);
    return 3;
  }
  if (result === "QUEUED") console.log(`QUEUED ${target}`);
  return 0;
}

function renderPrompt(d: Deps, name: string): string {
  const dir = join(d.store.root, "prompts");
  mkdirSync(dir, { recursive: true });
  const src = readFileSync(join(import.meta.dir, "..", "prompts", name), "utf8").replaceAll("{{dori}}", d.doriCmd);
  const out = join(dir, name);
  writeFileSync(out, src);
  return out;
}

async function up(d: Deps, cwd: string): Promise<void> {
  const env = { DORI_HOME: d.store.root };
  const lead = await d.herdr.createWorkspace("dori", cwd);
  await d.herdr.run(lead.paneId, `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, "lead.md"))}`);
  d.store.setRole("lead", lead.paneId);
  const duty = await d.herdr.createTab("duty", cwd, lead.workspaceId, env);
  await d.herdr.run(duty.paneId, `${d.agentCmd} --append-system-prompt ${shq(renderPrompt(d, "duty.md"))}`);
  d.store.setRole("duty", duty.paneId);
  const loop = await d.herdr.split(duty.paneId, cwd, env);
  await d.herdr.run(loop.paneId, `${d.doriCmd} duty --interval 60`);
  const hourly = await d.herdr.split(loop.paneId, cwd, { ...env, HERDR_WORKSPACE_ID: lead.workspaceId });
  await d.herdr.run(hourly.paneId, `${d.doriCmd} loop`);
  console.log(`UP lead=${lead.paneId} duty=${duty.paneId} loop=${loop.paneId} hourly=${hourly.paneId} home=${d.store.root}`);
}

function status(d: Deps): void {
  const roles = d.store.roles();
  console.log(`lead=${roles.lead ?? "-"} duty=${roles.duty ?? "-"} home=${d.store.root}`);
  for (const l of d.store.lanes()) {
    const last = l.log.at(-1);
    const age = Math.round((d.now() - l.lastActivityAt) / 60_000);
    console.log(`${l.key.padEnd(24)} ${l.status.padEnd(8)} ${l.paneId.padEnd(8)} active ${age}m ago  ${last ? `${last.kind}: ${last.text.slice(0, 60)}` : ""}`);
  }
}

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  const [cmd, x] = a.pos;
  if (cmd !== undefined && COMMANDS.has(cmd)) d.usage.touch();
  switch (cmd) {
    case "up":
      await up(d, resolve(one(a, "cwd") ?? process.cwd()));
      return 0;
    case "role": {
      const role = need(x, "role") as Role;
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const pane = need(a.pos[2] ?? process.env["HERDR_PANE_ID"], "pane id (not inside herdr?)");
      d.store.setRole(role, pane);
      console.log(`ROLE ${role}=${pane}`);
      return 0;
    }
    case "start": {
      const lane = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        cwd: one(a, "cwd"), workspace: one(a, "workspace"),
      });
      console.log(`STARTED ${lane.key} pane=${lane.paneId} brief=${lane.brief}`);
      return 0;
    }
    case "report": {
      const st = one(a, "status");
      if (st && st !== "working" && st !== "waiting") throw new Refusal("--status must be working or waiting");
      const sent = await report(d, need(x, "lane key"), await textOf(a), st as "working" | "waiting" | undefined);
      console.log(`REPORTED ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "ready": {
      const sent = await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? []);
      console.log(`READY ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "send": {
      const target = need(x, "target");
      const deliver = one(a, "to-shell") === "true" ? sendToShell : send;
      const sent = await deliver(d, target, await textOf(a), one(a, "from") ?? process.env["DORI_LANE"] ?? "cli");
      if (sent === "DELIVERED") console.log(`DELIVERED ${target}`);
      return deliveryOutcome(sent, target);
    }
    case "inbox": {
      const target = need(a.pos[2], "target");
      if (x === "list") {
        const { paneId, entries } = inboxList(d, target);
        if (entries.length === 0) console.log(`EMPTY ${paneId}`);
        for (const e of entries) console.log(`${e.index} ${e.state} from ${e.from} queued ${new Date(e.at).toISOString()} ${e.preview}`);
        return 0;
      }
      if (x === "ack" || x === "resend") {
        const index = Number(need(a.pos[3], "entry index (see dori inbox list)"));
        const paneId = releaseHeld(d, target, index, x);
        console.log(x === "ack" ? `ACKED ${paneId} ${index}` : `RELEASED ${paneId} ${index}: the next flush delivers it`);
        return 0;
      }
      throw new Refusal(`unknown inbox command ${x}\n\n${USAGE}`);
    }
    case "duty": {
      if (x === "stop") {
        d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand", "duty");
        console.log("DUTY STOPPED");
        return 0;
      }
      if (x === "resume") {
        d.store.clearStop("duty");
        console.log("DUTY RESUMED");
        return 0;
      }
      if (x === "status") {
        const stop = d.store.stop("duty");
        console.log(stop ? `stopped: ${stop.reason}` : "running (no stop file)");
        return 0;
      }
      if (x !== undefined) throw new Refusal(`unknown duty command ${x}\n\n${USAGE}`);
      const interval = Number(one(a, "interval") ?? "60") * 1000;
      do {
        for (const e of await dutyTick(d)) console.log(`DUTY ${[e.lane ?? e.pane, e.action].filter(Boolean).join(" ")}${e.detail ? `: ${e.detail}` : ""}`);
        if (one(a, "once")) break;
        await Bun.sleep(interval);
      } while (true);
      return 0;
    }
    case "loop": {
      if (x === "stop") {
        d.store.setStop(d.now(), one(a, "text") ?? "stopped by hand");
        console.log("LOOP STOPPED");
        return 0;
      }
      if (x === "resume") {
        d.store.clearStop();
        console.log("LOOP RESUMED");
        return 0;
      }
      if (x === "status") {
        const stop = d.store.stop();
        const last = d.store.lastRun();
        const age = last ? Math.round((d.now() - last.at) / 60_000) : undefined;
        console.log(
          stop
            ? `stopped: ${stop.reason}`
            : `armed (no stop file; ${age === undefined ? "no run recorded yet" : `last run ${age}m ago`})`,
        );
        console.log(last ? summary(last) : "no run yet");
        return 0;
      }
      if (x !== undefined) throw new Refusal(`unknown loop command ${x}\n\n${USAGE}`);
      const interval = Number(one(a, "interval") ?? String(HOUR / 1000)) * 1000;
      const opts = {
        interval,
        maxLanes: Number(one(a, "max-lanes") ?? process.env["DORI_MAX_LANES"] ?? "3"),
        maxStarts: Number(one(a, "max-starts") ?? process.env["DORI_MAX_STARTS"] ?? "2"),
        force: one(a, "force") === "true",
        ...(one(a, "max-load") ?? process.env["DORI_MAX_LOAD"] ? { maxLoad: Number(one(a, "max-load") ?? process.env["DORI_MAX_LOAD"]) } : {}),
      };
      const count = (n: number): boolean => Number.isInteger(n) && n >= 0;
      if (!(Number.isFinite(interval) && interval > 0) || !count(opts.maxLanes) || !count(opts.maxStarts) ||
        !(opts.maxLoad === undefined || (Number.isFinite(opts.maxLoad) && opts.maxLoad > 0))) {
        throw new Refusal("--interval and --max-load must be finite positive numbers; --max-lanes and --max-starts whole numbers >= 0");
      }
      do {
        try {
          const run = await loopTick(d, opts);
          console.log(run.skipped ? `LOOP skipped: ${run.skipped}` : `LOOP started=${run.started.length} findings=${run.findings.length} asked=${run.asked.length}`);
        } catch (e) {
          console.error(`LOOP ERROR ${e instanceof Error ? e.message : String(e)}`);
          if (one(a, "once")) return 1;
        }
        if (one(a, "once")) break;
        opts.force = false;
        await Bun.sleep(msUntilNext(d, interval));
      } while (true);
      return 0;
    }
    case "backlog": {
      if (x === "add") {
        const id = need(a.pos[2], "item id");
        const p = one(a, "priority");
        const item = backlogAdd(d, id, need(one(a, "brief"), "--brief"), {
          title: one(a, "title"), cwd: one(a, "cwd"), decision: one(a, "decision"),
          ...(p !== undefined ? { priority: Number(p) } : {}),
        });
        console.log(`ADDED ${item.id} p${item.priority}${item.decision ? " (needs decision)" : ""}`);
      } else if (x === "list" || x === undefined) {
        for (const i of d.store.items()) {
          console.log(`${i.id.padEnd(24)} ${i.status.padEnd(8)} p${i.priority}  ${i.decision ? `DECIDE: ${i.decision}` : i.title}`);
        }
      } else if (x === "decide") {
        const id = need(a.pos[2], "item id");
        backlogDecide(d, id, await textOf(a));
        console.log(`DECIDED ${id}`);
      } else if (x === "drop") {
        const id = need(a.pos[2], "item id");
        backlogDrop(d, id, one(a, "text"));
        console.log(`DROPPED ${id}`);
      } else if (x === "import") {
        const { added, capped } = await backlogImport(d, need(a.pos[2], "owner/repo"), one(a, "label") ?? "dori", one(a, "cwd"));
        console.log(`IMPORTED ${added.length}${added.length ? `: ${added.join(", ")}` : ""}`);
        if (capped) console.error(`WARNING: gh returned ${IMPORT_LIMIT} issues, the import limit; some labelled issues may be missing`);
      } else {
        throw new Refusal(`unknown backlog command ${x}\n\n${USAGE}`);
      }
      return 0;
    }
    case "review": {
      const r = await review(d, need(x, "PR"), one(a, "model"));
      console.log(`REVIEW ${x} head=${r.sha} verdict=${r.verdict}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
    case "merge":
      console.log(await mergeGate(d, need(x, "PR"), { dryRun: one(a, "dry-run") === "true" }));
      return 0;
    case "done":
      await done(d, need(x, "lane key"));
      console.log(`DONE ${x}`);
      return 0;
    case "status":
      status(d);
      return 0;
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" || cmd === "--help" ? 0 : 64;
  }
}

if (import.meta.main) {
  const deps = defaultDeps();
  let code = 0;
  try {
    code = await main(process.argv.slice(2), deps);
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    console.error(e.message);
    code = 2;
  } finally {
    await deps.usage.flush(2000);
  }
  process.exit(code);
}
