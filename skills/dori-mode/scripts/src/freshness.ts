import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { checkPausedLane } from "./pause.ts";
import { readScreen, sendVerified } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { type Progress, ReportError, reportLine, Reports } from "./reports.ts";

export const lastReportLine = (screen: string, key: string): string | null => {
  const grammar = new RegExp(`\\[REPORT\\] ${key.replace(/[.]/g, "\\.")} \\| (milestone|blocker|question|halted|done) \\| (?!<what)\\S`);
  const template = (l: string) => /["'`]\[REPORT\]/.test(l) && /\$?\{[A-Za-z_][\w.]*\}/.test(l);
  const hits = screen.split("\n").flatMap((l) => (grammar.test(l) && !template(l) ? [l.slice(l.indexOf("[REPORT]"))] : []));
  return hits.at(-1)?.replace(/["'\])\s,]+$/, "") ?? null;
};

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home).join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

// A report is a line that starts with [REPORT], or the last quoted element of an argv row, the shape lanes are told
// to send it in: ["herdr", "pane", "run", "lead:p1", "[REPORT] key | kind | text"]. Instructions
// and prompts that quote the grammar mid-sentence are dropped before parsing, so an example is never posted as the
// lane's progress. A report whose whole text is one unfilled placeholder ($name, ${name}, {name}, %s, <what>) is a
// template, quoted or not (#29). The match is anchored to the [REPORT] key | kind | text structure, so
// 'deployed api | %s' stays a real report.
const placeholderOnly = /^\s*\[REPORT\][^|]*\|[^|]*\|\s*["'`]?(\$\{?[A-Za-z_]\w*\}?|\{[A-Za-z_][\w.]*\}|%[sdif]|<[^>]+>)["'`)\s]*$/;
// An argv row is the whole line (optionally inside one spawn call): [ then quoted strings separated by commas, then ]. Only its last element can be the
// report, which is how lanes are told to send it. Prose that happens to contain a quoted report is not an argv row.
const argvElements = (line: string): string[] | null => {
  // A spawn call around the row, such as Bun.spawn([...]) or subprocess.run([...]), is the same row.
  const call = /^\s*[\w.$]+\(\s*(\[.*\])\s*\)\s*;?\s*$/.exec(line);
  const row = (call?.[1] ?? line).trim();
  if (!row.startsWith("[") || !row.endsWith("]")) return null;
  const element = /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*(,|$)/y;
  const inner = row.slice(1, -1);
  const elements: string[] = [];
  element.lastIndex = 0;
  while (element.lastIndex < inner.length) {
    const m = element.exec(inner);
    if (!m) return null;
    elements.push(m[1] ?? m[2] ?? "");
    if (m[3] === "") break;
  }
  return element.lastIndex === inner.length && elements.length > 0 ? elements : null;
};
const argvReport = (line: string): string | null => {
  const last = argvElements(line)?.at(-1);
  return last !== undefined && last.startsWith("[REPORT]") ? last : null;
};
const reportCandidate = (l: string): string | null => {
  if (!l.includes("[REPORT]")) return l;
  const report = /^\s*\[REPORT\]/.test(l) ? l : argvReport(l);
  return report !== null && !placeholderOnly.test(report) ? report : null;
};
export const anchoredReportLine = (screen: string, key: string): string | null =>
  lastReportLine(
    screen
      .split("\n")
      .flatMap((l) => reportCandidate(l) ?? [])
      .join("\n"),
    key,
  );

export type SweepAct = {
  readonly kind: "nudged" | "posted" | "no-report" | "pending-report" | "stale-report" | "working-while-paused" | "stalled" | "journal-error";
  readonly lane: string;
  readonly detail: string;
};

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

export const freshnessTick = async (deps: FlowDeps, home: string): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const now = deps.clock.now();
  const reports = new Reports(deps.config.stateDir);
  for (const lane of await deps.registry.open()) {
    if (statusOf(lane) === "paused") {
      const checked = await checkPausedLane(deps, lane);
      if (checked && checked.lane.lastFreshnessNote !== "working-while-paused") {
        // Reported once per working stretch (the note clears when the lane goes idle), so the lead can ask; it stays paused.
        await deps.registry.write({ ...checked.lane, lastFreshnessNote: "working-while-paused" });
        acts.push({ kind: "working-while-paused", lane: lane.key, detail: "paused lane is working on two ticks; left paused (resume is dori resume only)" });
      }
      continue;
    }
    if (statusOf(lane) !== "working" || !lane.pane) continue;
    // Only launched lanes report through the journal; an adopted lane keeps the screen path even if a record exists.
    let previous: Progress | null = null;
    let progress: Progress | null = null;
    if (lane.reportProtocol === "jsonl-v1") {
      try {
        previous = reports.read(lane.key);
        progress = previous ? reports.observe(lane.key, await readScreen(deps.run, lane.pane), now, deps.config.nudgeAfterMin * 60_000) : null;
      } catch (error) {
        // One corrupt journal skips its own lane, printed once per error, and never ends the sweep for the others.
        if (!(error instanceof ReportError)) throw error;
        const note = `journal-error|${error.message}`;
        if (note !== lane.lastFreshnessNote) {
          acts.push({ kind: "journal-error", lane: lane.key, detail: error.message });
          await deps.registry.write({ ...lane, lastFreshnessNote: note });
        }
        continue;
      }
    }
    if (progress?.state === "stalled" && previous?.state !== "stalled") {
      acts.push({ kind: "stalled", lane: lane.key, detail: progress.lastEvent.text });
    }
    if (progress?.state === "stalled") continue;
    // A blocker, question, halted or done lane is not nudged, but its report still reaches the thread.
    const running = !progress || progress.state === "running";
    const heard = Math.max(lastHeard(lane), progress?.lastReport ? Date.parse(progress.lastReport.at) : 0);
    const silentMin = Math.round((now - heard) / 60_000);
    let current = lane;
    if (running && silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      const delivery = await sendVerified(deps.run, deps.clock, lane.pane, `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`);
      current = { ...current, lastNudgeAt: now };
      await deps.registry.write(current);
      acts.push({ kind: "nudged", lane: lane.key, detail: `${silentMin} min silent, delivery ${delivery}` });
    }
    const hook = deps.config.hooks.threadReply;
    // The post waits for the thread to be quiet, not the lane: a report resets the nudge clock only, so a lane that
    // reports often still gets its latest report posted, at most once per postAfterMin.
    const threadQuietMin = Math.round((now - Math.max(lastHeard(lane), lane.lastAutoReplyAt ?? 0)) / 60_000);
    // A report stamped in the same millisecond as the last post still counts (<=); lastPostedReport stops a repeat.
    if (threadQuietMin >= deps.config.postAfterMin && hook && lane.thread !== "none" && (current.lastAutoReplyAt ?? 0) <= heard) {
      // A journal report is durable, so it skips the two-tick hold; a screen-scraped line counts only once it is still
      // there on the next tick (the two reads are a full loop interval apart).
      const fromJournal = progress?.lastReport ? reportLine(progress.lastReport) : null;
      const report = fromJournal ?? (lane.reportProtocol === "jsonl-v1" ? null : anchoredReportLine(await readScreen(deps.run, lane.pane, 200), lane.key));
      const seenBefore = current.lastSeenReport;
      current = { ...current, lastSeenReport: report ?? undefined };
      let hold: { kind: SweepAct["kind"]; detail: string } | null = null;
      if (!report) hold = { kind: "no-report", detail: lane.reportProtocol === "jsonl-v1" ? "report journal has no report" : "pane has no [REPORT] line" };
      else if (!fromJournal && report !== seenBefore) hold = { kind: "pending-report", detail: "a new [REPORT] line; posting once it holds on the next tick" };
      else if (report === current.lastPostedReport) hold = { kind: "stale-report", detail: "the last [REPORT] line was already posted" };
      if (hold) {
        const note = `${hold.kind}|${hold.detail}|${report ?? ""}`;
        if (note !== current.lastFreshnessNote) acts.push({ kind: hold.kind, lane: lane.key, detail: hold.detail });
        await deps.registry.write({ ...current, lastFreshnessNote: note });
        continue;
      }
      const text = `Progress (from the lane's last report): ${scrubForThread(report ?? "", home)}`;
      await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      await deps.registry.write({ ...current, lastAutoReplyAt: now, lastPostedReport: report ?? undefined, lastFreshnessNote: undefined });
      acts.push({ kind: "posted", lane: lane.key, detail: text });
    }
  }
  return acts;
};
