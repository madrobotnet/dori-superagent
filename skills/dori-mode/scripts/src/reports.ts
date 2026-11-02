import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { LANE_KEY } from "./registry.ts";

export type ReportKind = "milestone" | "blocker" | "halted" | "done";
export type ProgressState = "running" | "blocked" | "halted" | "done" | "stalled";
export type Report = {
  readonly type: "report";
  readonly key: string;
  readonly at: string;
  readonly kind: ReportKind;
  readonly text: string;
};
export type Activity = {
  readonly type: "activity";
  readonly key: string;
  readonly at: string;
  readonly state: "running" | "stalled";
  readonly text: string;
};
export type LaneEvent = Report | Activity;
export type Progress = {
  readonly state: ProgressState;
  readonly lastReport: Report | null;
  readonly lastEvent: LaneEvent;
};

export class ReportError extends Error {}

export const isReportKind = (value: unknown): value is ReportKind =>
  value === "milestone" || value === "blocker" || value === "halted" || value === "done";

export const reportState = (kind: ReportKind): ProgressState => {
  switch (kind) {
    case "milestone": return "running";
    case "blocker": return "blocked";
    case "halted": return "halted";
    case "done": return "done";
  }
};

// The printed line goes to terminals, so escape sequences and other control characters are dropped from it (a CR or
// newline becomes one space); the journal keeps the raw text.
export const reportLine = (report: Report): string =>
  `[REPORT] ${report.key} | ${report.kind} | ${Bun.stripANSI(report.text).replace(/\s*[\r\n]+\s*/g, " ").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}`;

export const parseEvent = (line: string, key: string): LaneEvent => {
  const value: unknown = JSON.parse(line);
  if (typeof value !== "object" || value === null || !("key" in value) || value.key !== key ||
      !("at" in value) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !("text" in value) || typeof value.text !== "string" || !value.text.trim() || !("type" in value)) {
    throw new ReportError(`invalid report record for ${key}`);
  }
  const common = { key, at: value.at, text: value.text };
  if (value.type === "report" && "kind" in value && isReportKind(value.kind)) {
    return { ...common, type: "report", kind: value.kind };
  }
  if (value.type === "activity" && "state" in value && (value.state === "running" || value.state === "stalled")) {
    return { ...common, type: "activity", state: value.state };
  }
  throw new ReportError(`invalid report kind or activity state for ${key}`);
};

// One O_APPEND write per event: concurrent lane/lead writers cannot overwrite
// each other's state. The last event is the persisted progress state; no
// second mutable snapshot can race with this journal or registry done claims.
export class Reports {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new ReportError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "reports.jsonl");
  }

  read(key: string): Progress | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    let progress: Progress | null = null;
    let lastReport: Report | null = null;
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      let event: LaneEvent;
      try {
        event = parseEvent(line, key);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof ReportError)) throw error;
        throw new ReportError(`${path}:${index + 1}: ${error.message}`);
      }
      if (event.type === "report") {
        lastReport = event;
        progress = { state: reportState(event.kind), lastReport: event, lastEvent: event };
      } else if (!progress || progress.state === "running" || progress.state === "stalled") {
        progress = { state: event.state, lastReport, lastEvent: event };
      }
    }
    return progress;
  }

  append(event: LaneEvent): void {
    const path = this.path(event.key);
    parseEvent(JSON.stringify(event), event.key);
    mkdirSync(join(this.stateDir, "lanes", event.key), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  report(key: string, kind: ReportKind, text: string, now: number): Report {
    const report: Report = { type: "report", key, kind, text: text.trim(), at: new Date(now).toISOString() };
    this.append(report);
    return report;
  }

  observe(key: string, screen: string, now: number, staleAfterMs: number): Progress | null {
    const progress = this.read(key);
    if (!progress || (progress.state !== "running" && progress.state !== "stalled")) return progress;
    const visible = Bun.stripANSI(screen);
    const lastAt = (pattern: RegExp): number => {
      let at = -1;
      for (const match of visible.matchAll(pattern)) at = match.index;
      return at;
    };
    const workingAt = lastAt(/^\s*[^\w\n]*Working\b/gim);
    const working = workingAt >= 0;
    // A failure counts only when no Working line follows it: an old error left on screen above a recovered lane is history.
    const failed = lastAt(/compaction (?:failed|failure|error)|failed to compact|error (?:during|in) compaction|auto-?compaction failed/gi) > workingAt;
    const idle = /^\s*[❯>]\s*$/m.test(visible);
    const stale = now - Date.parse(progress.lastReport?.at ?? progress.lastEvent.at) >= staleAfterMs;
    const state = failed || (idle && !working && stale) ? "stalled" : working ? "running" : progress.state;
    if (state === progress.state) return progress;
    const event: Activity = {
      type: "activity", key, at: new Date(now).toISOString(), state,
      text: failed ? "compaction failed" : state === "stalled" ? "idle prompt without Working or a fresh report" : "Working activity resumed",
    };
    this.append(event);
    return this.read(key);
  }
}
