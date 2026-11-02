#!/usr/bin/env bun
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import { bootCheck, slackAuthCheck } from "./boot.ts";
import { loadConfig } from "./config.ts";
import { deadPaneTick, newDeadPaneState } from "./dead-panes.ts";
import { claimDone, closeLane, type FlowDeps, objectDone, watchTick } from "./done-flow.ts";
import { freshnessTick } from "./freshness.ts";
import { acquireSlot, pidAlive, releaseSlot } from "./heavy-slot.ts";
import { guardTick, sampleHost } from "./host-guard.ts";
import { adoptLane, launchLane, LaunchError } from "./launch.ts";
import { pauseLane, resumeLane } from "./pause.ts";
import { Registry, statusOf } from "./registry.ts";
import { isReportKind, reportLine, ReportError, Reports } from "./reports.ts";
import { realClock, run } from "./run.ts";
import { syncRegistry } from "./sync.ts";
import { canLaunch } from "./routing.ts";
import { fetchHttp, MessengerError, UnsafeMessageError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { slackPresence } from "./messenger/slack-presence.ts";
import { Telegram } from "./messenger/telegram.ts";
import { Discord, discordPresence } from "./messenger/discord.ts";
import { realTimers } from "./messenger/typing.ts";
import { transcribe, TranscriptionError } from "./messenger/voice.ts";
import { formatVerifyPr, verifyPr } from "./verify-pr.ts";
import { CheckpointError, Checkpoints } from "./checkpoints.ts";

const USAGE = `dori <command> [options]

  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
         [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...]
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF]
  sync   [--write]                     registry vs live panes; read-only unless --write
  boot                                 read-only check after a restart: Slack auth, vanished panes, journals, stale watches
  report <key> --kind milestone|blocker|question|halted|done --text TEXT
                                       append a durable progress report and print its [REPORT] line
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT ...]
                                       record a completed step once; a conflicting rewrite is refused
  checkpoints <key>                    read completed steps before resuming remote work
  verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]
                                       check every commit's author/committer email and PR-level tests; print the UI test loop (not run)
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for $HERDR_PANE_ID
  object-done <key> --reason TEXT [--reason TEXT ...]
  close  <key> [--note TEXT]           close now (Done signals must read back live)
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]
                                       post or edit a message (tokens from DORI_SLACK_TOKEN, DORI_TELEGRAM_TOKEN, DORI_DISCORD_TOKEN)
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file>              run hooks.transcribe and print the text
  inbound slack [--loop MIN]           print INBOUND lines: unread thread replies (threads view), replies in threads
                                       the Dori posted in (any helper), DMs and channels with unread mentions`;

const die = (message: string, code = 1): never => {
  console.error(message);
  process.exit(code);
};

const config = await loadConfig();
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
const [command = "", ...rest] = process.argv.slice(2);

const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" }, brief: { type: "string" }, done: { type: "string" }, thread: { type: "string" },
    model: { type: "string" }, cwd: { type: "string" }, pane: { type: "string" }, evidence: { type: "string" },
    reason: { type: "string", multiple: true }, note: { type: "string" }, write: { type: "boolean" }, loop: { type: "string" },
    to: { type: "string" }, text: { type: "string" }, edit: { type: "string" }, kind: { type: "string" },
    step: { type: "string" }, result: { type: "string" }, "remote-effect": { type: "string", multiple: true },
    "wall-minutes": { type: "string" }, "token-limit": { type: "string" }, "cost-limit": { type: "string" },
    "activity-path": { type: "string", multiple: true },
  },
});
const opt = (name: string): string | undefined => {
  const v = flags.values[name];
  return typeof v === "string" ? v.trim() : undefined;
};
const need = (name: string): string => opt(name) || die(`--${name} is required`);
const key = flags.positionals[0];
const loopMin = Number(opt("loop") ?? 0);
const strings = (name: string): string[] => {
  const value = flags.values[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
};
const ceiling = (name: string): number | null | undefined => {
  const value = opt(name);
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed >= 0 ? parsed : die(`--${name} must be a nonnegative number or none`);
};

const lane = async (k: string | undefined) => {
  const found = k ? await deps.registry.read(k) : await deps.registry.byPane(process.env.HERDR_PANE_ID ?? "");
  if (!found) return die(k ? `no registered lane "${k}"` : "no open lane is registered for this pane");
  if (statusOf(found) === "closed") return die(`lane ${found.key} is already closed`);
  return found;
};

const every = async (minutes: number, tick: () => Promise<void>): Promise<void> => {
  for (;;) {
    await tick().catch((e: unknown) => console.log(`WARN ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
    if (minutes <= 0) return;
    await Bun.sleep(minutes * 60_000);
  }
};

try {
  switch (command) {
    case "report": {
      const target = await lane(key ?? die("report needs a lane key"));
      const kind = need("kind");
      if (isReportKind(kind)) {
        console.log(reportLine(new Reports(config.stateDir).report(target.key, kind, need("text"), realClock.now())));
      } else die("--kind must be milestone, blocker, question, halted or done");
      break;
    }
    case "launch": {
      const wallMinutes = ceiling("wall-minutes"), tokens = ceiling("token-limit"), costUsd = ceiling("cost-limit");
      const r = await launchLane(deps, {
        key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), model: opt("model"), cwd: opt("cwd"),
        budget: { ...(wallMinutes !== undefined ? { wallMinutes } : {}), ...(tokens !== undefined ? { tokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) },
        activityPaths: strings("activity-path"),
      });
      console.log(`LAUNCHED ${r.lane.key} pane=${r.lane.pane} tab=${r.lane.tab ?? "?"}`);
      console.log(r.startup);
      process.exit(r.startup.startsWith("STARTUP_OK") ? 0 : 3);
    }
    case "adopt": {
      const l = await adoptLane(deps, { key: key ?? "", title: need("title"), brief: need("brief"), done: need("done"), thread: opt("thread"), pane: need("pane") });
      console.log(`ADOPTED ${l.key} pane=${l.pane} thread=${l.thread}`);
      break;
    }
    case "sync": {
      const r = await syncRegistry(deps, Boolean(flags.values.write));
      console.log("key | thread | pane | session | status");
      for (const row of [...r.rows, ...r.unregistered]) console.log([row.key, row.thread, row.pane, row.session, row.status].join(" | "));
      console.log(r.drift.length ? `DRIFT (${r.drift.length}):\n${r.drift.map((d) => `- ${d}`).join("\n")}` : "DRIFT none");
      console.log(flags.values.write ? "WROTE session ids" : "READ_ONLY");
      break;
    }
    case "boot": {
      const token = process.env.DORI_SLACK_TOKEN;
      const slack = token ? new Slack(fetchHttp, realClock, { token, cookie: process.env.DORI_SLACK_COOKIE }) : null;
      const sessionDirs = [process.env.PI_SESSION_DIR, process.env.PI_SESSION_FILE && dirname(process.env.PI_SESSION_FILE)];
      const r = await bootCheck({
        ...deps,
        reports: new Reports(config.stateDir),
        slack: slackAuthCheck(slack),
        monitorDirs: sessionDirs.flatMap((dir) => (dir ? [join(dir, "extensions", "terminal")] : [])),
      });
      for (const line of r.lines) console.log(line);
      process.exit(r.exitCode);
    }
    case "checkpoint": {
      const target = await lane(key ?? die("checkpoint needs a lane key"));
      const result = new Checkpoints(config.stateDir).write(target.key, {
        step: need("step"), result: need("result"), evidence: [need("evidence")], remoteEffects: strings("remote-effect"),
      }, realClock.now());
      console.log(JSON.stringify(result));
      break;
    }
    case "checkpoints": {
      if (!key || !(await deps.registry.read(key))) die("checkpoints needs a registered lane key");
      console.log(JSON.stringify(new Checkpoints(config.stateDir).read(key ?? ""), null, 2));
      break;
    }
    case "verify-pr": {
      const repo = key ?? die("verify-pr needs owner/repo and a PR number");
      const result = await verifyPr(repo, Number(flags.positionals[1]), run, {
        expectedIdentity: config.repoIdentities[repo.toLowerCase()],
        loopCount: Number(opt("loop") ?? 20),
        cwd: opt("cwd"),
      });
      console.log(formatVerifyPr(result));
      process.exit(result.ok ? 0 : 2);
    }
    case "claim-done":
      console.log(await claimDone(deps, await lane(key), need("evidence")));
      break;
    case "object-done": {
      const reasons = (flags.values.reason as string[] | undefined)?.map((r) => r.trim()).filter(Boolean) ?? [];
      if (!reasons.length) die("--reason is required");
      console.log(await objectDone(deps, await lane(key ?? die("object-done needs a lane key")), reasons));
      break;
    }
    case "close": {
      const r = await closeLane(deps, await lane(key ?? die("close needs a lane key")), opt("note") ?? "closed by the lead");
      for (const line of r.lines) console.log(line);
      process.exit(r.closed ? 0 : 2);
    }
    case "pause":
    case "resume": {
      const act = command === "pause" ? pauseLane : resumeLane;
      const r = await act(deps, await lane(key ?? die(`${command} needs a lane key`)), opt("note") ?? `${command}d by the lead`);
      for (const line of r.lines) console.log(line);
      process.exit(r.code);
    }
    case "watch":
      console.log("LANE_WATCH_READY");
      for (;;) {
        for (const line of await watchTick(deps).catch((e: unknown) => [`LANE_WATCH_WARN ${String(e).slice(0, 200)}`])) console.log(line);
        await Bun.sleep(30_000);
      }
    case "freshness":
      await every(loopMin, async () => {
        for (const a of await freshnessTick(deps, process.env.HOME ?? "")) console.log(`${a.kind.toUpperCase()} ${a.lane} ${a.detail}`);
      });
      break;
    case "dead-panes": {
      const seen = new Set<string>();
      const paneState = newDeadPaneState();
      await every(loopMin, async () => {
        for (const line of await deadPaneTick(run, config, seen, new Date().toISOString().slice(0, 13), paneState)) console.log(line);
      });
      break;
    }
    case "guard": {
      const state = { alerting: false };
      console.log("HOST_GUARD_READY");
      await every(loopMin, async () => {
        for (const line of guardTick(await sampleHost(run), config.guard, state)) console.log(line);
      });
      break;
    }
    case "heavy": {
      const sep = rest.indexOf("--");
      const label = rest[0];
      const cmd = sep >= 0 ? rest.slice(sep + 1) : [];
      if (!label || label === "--" || !cmd.length) die("usage: dori heavy <label> -- <command ...>");
      const load = async () => (await sampleHost(run)).load1;
      const slot = await acquireSlot({ dir: `${config.stateDir}/heavy`, slots: config.heavySlots, maxLoad: config.heavyMaxLoad, clock: realClock, load, alive: pidAlive, pid: process.pid }, label ?? "");
      try {
        const child = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
        process.exitCode = await child.exited;
      } finally {
        releaseSlot(slot);
      }
      break;
    }
    case "can-launch": {
      const v = canLaunch(await sampleHost(run), config.guard);
      console.log(v.ok ? "CAN_LAUNCH" : `HOLD ${v.reasons.join(" | ")}`);
      process.exit(v.ok ? 0 : 4);
    }
    case "send": {
      const platform = key ?? die("send needs slack, telegram or discord");
      const to = need("to");
      const text = need("text");
      const thread = opt("thread");
      const edit = opt("edit");
      const token = (name: string) => process.env[name] ?? die(`${name} is not set`);
      if (platform === "slack") {
        const slack = new Slack(fetchHttp, realClock, { token: token("DORI_SLACK_TOKEN"), cookie: process.env.DORI_SLACK_COOKIE }, undefined, new ThreadLedger(`${config.stateDir}/slack-threads.json`));
        if (edit) await slack.edit(to, edit, text);
        else console.log(`SENT ${(await slack.post(to, text, thread)).ts}`);
      } else if (platform === "telegram") {
        const tg = new Telegram(fetchHttp, realClock, token("DORI_TELEGRAM_TOKEN"));
        const target = { chatId: to, ...(thread ? { threadId: Number(thread) } : {}) };
        if (edit) await tg.edit(target, Number(edit), text);
        else console.log(`SENT ${await tg.send(target, text)}`);
      } else if (platform === "discord") {
        const dc = new Discord(fetchHttp, realClock, token("DORI_DISCORD_TOKEN"));
        if (edit) await dc.edit(to, edit, text);
        else console.log(`SENT ${await dc.send(thread ?? to, text)}`);
      } else die(`unknown platform ${platform}`);
      break;
    }
    case "presence": {
      if (key === "slack") {
        const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE ?? die("DORI_SLACK_COOKIE is not set (user-token presence needs the d cookie)") };
        const p = slackPresence(new Slack(fetchHttp, realClock, auth), (url, headers) => {
          const options: Bun.WebSocketOptions = { headers: { ...headers } };
          const ws = new WebSocket(url, options);
          return { isOpen: () => ws.readyState === WebSocket.OPEN, send: (f) => ws.send(f), close: () => ws.close() };
        }, auth);
        console.log("PRESENCE_READY slack");
        await every(1, async () => console.log(`PRESENCE slack ${await p.hold()}`));
      } else if (key === "discord") {
        const token = process.env.DORI_DISCORD_TOKEN ?? die("DORI_DISCORD_TOKEN is not set");
        discordPresence(() => {
          const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
          let handler: (d: string) => void = () => {};
          ws.addEventListener("message", (e) => handler(String(e.data)));
          return { send: (d) => ws.send(d), close: () => ws.close(), onMessage: (cb) => { handler = cb; } };
        }, token, realTimers);
        console.log("PRESENCE_READY discord");
        await new Promise(() => {});
      } else die("presence needs slack or discord");
      break;
    }
    case "inbound": {
      if (key !== "slack") die("inbound supports slack");
      const auth = { token: process.env.DORI_SLACK_TOKEN ?? die("DORI_SLACK_TOKEN is not set"), cookie: process.env.DORI_SLACK_COOKIE };
      const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
      const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
      const me = String((await slack.call("auth.test", {})).user_id ?? die("auth.test returned no user_id"));
      console.log("INBOUND_READY slack");
      await every(loopMin, async () => {
        for (const i of await pollSlackInbound(slack, ledger, { selfUserId: me })) console.log(`INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify((i.text ?? "").slice(0, 200))}`);
      });
      break;
    }
    case "transcribe":
      console.log(await transcribe(run, config.hooks.transcribe, key ?? die("transcribe needs an audio file path")));
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
} catch (e) {
  if (e instanceof LaunchError || e instanceof UnsafeMessageError || e instanceof MessengerError || e instanceof TranscriptionError || e instanceof ReportError || e instanceof CheckpointError) die(e.message);
  throw e;
}
