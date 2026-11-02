import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Checkpoints } from "./checkpoints.ts";
import { fill } from "./config.ts";
import type { Lane } from "./registry.ts";
import { Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";

export type BudgetLimits = { readonly wallMinutes?: number | null; readonly tokens?: number | null; readonly costUsd?: number | null };
export type Usage = { readonly tokens: number | null; readonly costUsd: number | null };
export type UsageSnapshot = Usage & { readonly key: string; readonly at: string };
export type SupervisedLane = Lane & { readonly activityPaths?: readonly string[]; readonly budget?: BudgetLimits };
export type SupervisionOptions = {
  readonly hungAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
  readonly defaults?: BudgetLimits;
  readonly lanes?: Readonly<Record<string, BudgetLimits>>;
  readonly usageArgv?: readonly string[];
  readonly recordCostArgv?: readonly string[];
  readonly activityPaths?: readonly string[];
  readonly gitActivity?: boolean;
};
export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly clock: Pick<Clock, "now">;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
};
export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
};
type Observation = {
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  readonly activity: string;
  readonly activeAt: number;
  readonly alerts: readonly string[];
};

// Match only an explicit duration on a visible Working/Running line.
export const workingTimer = (screen: string): { kind: string; seconds: number } | null => {
  for (const line of Bun.stripANSI(screen).split("\n")) {
    const kind = /^\s*[^\w\n]*(Working|Running)\b/i.exec(line)?.[1]?.toLowerCase();
    if (!kind) continue;
    const clock = /\b(\d+):(\d{2})(?::(\d{2}))?\b/.exec(line);
    if (clock) {
      const seconds = clock[3] === undefined ? Number(clock[1]) * 60 + Number(clock[2]) :
        Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      return { kind, seconds };
    }
    const parts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi)];
    if (parts.length) return { kind, seconds: parts.reduce((sum, match) =>
      sum + Number(match[1]) * (/^h/i.test(match[2] ?? "") ? 3600 : /^m/i.test(match[2] ?? "") ? 60 : 1), 0) };
  }
  return null;
};

export class Supervision {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  constructor(readonly deps: SupervisionDeps, readonly options: SupervisionOptions = {}) {
    this.reports = deps.reports ?? new Reports(deps.stateDir);
    this.checkpoints = new Checkpoints(deps.stateDir);
  }

  private enabled(lane: SupervisedLane): boolean {
    return lane.reportProtocol === "jsonl-v1" || existsSync(this.reports.path(lane.key));
  }

  private async usage(lane: SupervisedLane, now: number): Promise<UsageSnapshot> {
    let usage: Usage = { tokens: null, costUsd: null };
    if (this.options.usageArgv?.length) {
      const result = await this.deps.run(fill(this.options.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }), { cwd: lane.cwd, timeoutMs: 10_000 });
      if (result.code === 0) {
        try {
          const value: unknown = JSON.parse(result.out);
          const metric = (name: "tokens" | "costUsd"): number | null => {
            const n = typeof value === "object" && value !== null && name in value ? (value as Record<string, unknown>)[name] : null;
            return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
          };
          usage = { tokens: metric("tokens"), costUsd: metric("costUsd") };
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // Malformed external JSON remains unknown, never zero.
        }
      }
    }
    const snapshot = { key: lane.key, at: new Date(now).toISOString(), ...usage };
    const path = join(dirname(this.reports.path(lane.key)), "cost.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    return snapshot;
  }

  private async activity(lane: SupervisedLane): Promise<string> {
    const paths = new Set([...(this.options.activityPaths ?? []), ...(lane.activityPaths ?? [])]
      .map((path) => resolve(lane.cwd ?? ".", path)));
    const changes: string[] = [];
    if (this.options.gitActivity !== false && lane.cwd) {
      const result = await this.deps.run(["git", "-C", lane.cwd, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { timeoutMs: 10_000, preserveOutput: true });
      if (result.code === 0) {
        const entries = result.out.split("\0");
        for (let index = 0; index < entries.length; index++) {
          const entry = entries[index];
          if (!entry) continue;
          const name = entry.slice(3);
          const path = resolve(lane.cwd, name);
          const rel = relative(resolve(lane.cwd), path);
          if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.split("/").includes("node_modules")) paths.add(path);
          changes.push(entry);
          if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index++;
        }
      }
    }
    const files = [...paths].sort().map((path) => {
      try {
        const stat = lstatSync(path);
        return [path, stat.mtimeMs, stat.ctimeMs, stat.size];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return [path, null];
      }
    });
    // Activity state entries generated by supervision are not agent progress.
    const progress = this.reports.read(lane.key);
    const checkpoints = this.checkpoints.read(lane.key);
    return JSON.stringify({ report: progress?.lastReport ?? null, checkpoint: checkpoints.at(-1) ?? null, files, changes: changes.sort() });
  }

  async sweep(lane: SupervisedLane, screen: string): Promise<SupervisionResult> {
    if (!this.enabled(lane)) return { enabled: false, state: null, alerts: [], usage: null, hung: false };
    const now = this.deps.clock.now();
    const path = join(dirname(this.reports.path(lane.key)), "supervision.json");
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Observation : null;
    const activity = await this.activity(lane);
    const timer = workingTimer(screen);
    const activeAt = !previous || activity !== previous.activity ? now : previous.activeAt;
    const usage = await this.usage(lane, now);
    const limits = { wallMinutes: 240, tokens: null, costUsd: null, ...this.options.defaults, ...this.options.lanes?.[lane.key], ...lane.budget };
    const violations: string[] = [];
    const exceeds = (name: keyof BudgetLimits, actual: number | null): void => {
      const ceiling = limits[name];
      if (typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 && actual !== null && actual >= ceiling) violations.push(`${name} ceiling reached (${ceiling})`);
    };
    exceeds("wallMinutes", (now - Date.parse(lane.openedAt)) / 60_000);
    exceeds("tokens", usage.tokens);
    exceeds("costUsd", usage.costUsd);
    const hung = previous !== null && timer !== null && previous.timer !== null &&
      timer.kind === previous.timerKind && timer.seconds > previous.timer &&
      // A changed timer origin means a new call, even if its duration is larger.
      Math.abs((now - timer.seconds * 1000) - (previous.at - previous.timer * 1000)) <= 2000 &&
      timer.seconds >= (this.options.hungAfterMinutes ?? 20) * 60 &&
      now - activeAt >= (this.options.staleAfterMinutes ?? 20) * 60_000;
    const progress = this.reports.read(lane.key);
    const terminal = progress?.state === "done" || progress?.state === "halted";
    const unavailable = (["tokens", "costUsd"] as const)
      .filter((name) => typeof limits[name] === "number" && usage[name] === null)
      .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
    const hungMessage = "Working/Running timer exceeded threshold without fresh report, checkpoint, or file activity";
    const alerts = terminal ? [] : [...(violations.length ? violations : hung ? [hungMessage] : []), ...unavailable];
    const freshAlerts = alerts.filter((message) => !previous?.alerts.includes(message));
    if (!terminal && violations.length && progress?.state !== "blocked") {
      this.reports.report(lane.key, "blocker", violations.join("; "), now);
    } else if (!terminal && hung && (!progress || progress.state === "running")) {
      this.reports.append({ type: "activity", key: lane.key, at: new Date(now).toISOString(), state: "stalled", text: hungMessage });
    } else if (!alerts.length && progress?.state === "stalled" && activity !== previous?.activity) {
      this.reports.append({ type: "activity", key: lane.key, at: new Date(now).toISOString(), state: "running", text: "Fresh report, checkpoint, or file activity observed" });
    }
    // Save the post-blocker signature so our own report does not count as progress.
    const observation: Observation = { at: now, timer: timer?.seconds ?? null, timerKind: timer?.kind ?? null, activity: await this.activity(lane), activeAt, alerts };
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
    renameSync(temporary, path);
    for (const message of freshAlerts) await this.deps.alert?.(lane, message);
    return { enabled: true, state: this.reports.read(lane.key)?.state ?? "running", alerts: freshAlerts, usage, hung };
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    if (!this.enabled(lane)) return null;
    const snapshot = await this.usage(lane, this.deps.clock.now());
    if (this.options.recordCostArgv?.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(fill(this.options.recordCostArgv, {
        key: lane.key, session: lane.session ?? "", tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
        costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd), at: snapshot.at,
      }), { cwd: lane.cwd, timeoutMs: 10_000 });
      if (result.code !== 0) throw new Error(`recordCost failed for ${lane.key}: ${result.err}`);
    }
    return snapshot;
  }
}
