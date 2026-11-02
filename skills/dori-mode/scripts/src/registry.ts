import { mkdirSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const LANE_KEY = /^[a-z0-9][a-z0-9._-]{1,60}$/;

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";
export type Claim = { readonly at: string; readonly evidence: string; readonly emitted?: boolean };
export type Objection = { readonly at: string; readonly reasons: readonly string[] };
export type HistoryEntry = { readonly at: string; readonly status: LaneStatus; readonly note: string };

export type Lane = {
  readonly key: string;
  readonly title: string;
  readonly thread: string;
  readonly pane?: string;
  readonly tab?: string;
  readonly session?: string;
  readonly sessionVia?: string;
  readonly brief: string;
  readonly done: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly worktrees?: readonly string[];
  readonly status?: LaneStatus;
  readonly claim?: Claim;
  readonly objection?: Objection;
  readonly history?: readonly HistoryEntry[];
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly lastReplyAt?: number;
  readonly lastNudgeAt?: number;
  readonly lastAutoReplyAt?: number;
  /** The [REPORT] line the freshness sweep last posted, so a stale screen is never posted twice. */
  readonly lastPostedReport?: string;
  /** The [REPORT] line seen on the previous freshness tick (a line is posted only once it holds across two ticks). */
  readonly lastSeenReport?: string;
  /** The last held-back freshness outcome, so a quiet lane logs each state change once, not every tick. */
  readonly lastFreshnessNote?: string;
  /** A paused lane whose pane read working on the previous freshness tick (two in a row is reported, never a resume). */
  readonly pausedSeenWorking?: boolean;
  /** The status a paused lane had before it was paused; `resume` restores it. */
  readonly pausedFrom?: LaneStatus;
  readonly reportProtocol?: "jsonl-v1";
  readonly receipt?: unknown;
};

export const statusOf = (lane: Lane): LaneStatus => (lane.closedAt ? "closed" : (lane.status ?? "working"));

export const withStatus = (lane: Lane, status: LaneStatus, note: string, at: string, patch: Partial<Lane> = {}): Lane => ({
  ...lane,
  ...patch,
  status,
  history: [...(lane.history ?? []), { at, status, note }],
});

export class Registry {
  readonly dir: string;
  constructor(stateDir: string) {
    this.dir = join(stateDir, "lanes");
  }

  path(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Lane | null> {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? ((await f.json()) as Lane) : null;
  }

  // temp file + rename so a concurrent reader never sees a half-written lane
  async write(lane: Lane): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path(lane.key)}.${process.pid}.tmp`;
    await Bun.write(tmp, JSON.stringify(lane, null, 1));
    renameSync(tmp, this.path(lane.key));
  }

  // Reading never creates the lanes directory (dori boot is read-only); write() creates it.
  private files(): string[] {
    try {
      return readdirSync(this.dir).filter((f) => f.endsWith(".json")).map((f) => join(this.dir, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async list(): Promise<Lane[]> {
    const lanes: Lane[] = [];
    for (const f of this.files()) lanes.push((await Bun.file(f).json()) as Lane);
    return lanes;
  }

  /** Like list(), but a lane file that cannot be read or parsed is returned in `unreadable` instead of throwing. */
  async scan(): Promise<{ lanes: Lane[]; unreadable: string[] }> {
    const lanes: Lane[] = [];
    const unreadable: string[] = [];
    for (const f of this.files()) {
      try {
        lanes.push((await Bun.file(f).json()) as Lane);
      } catch {
        unreadable.push(f);
      }
    }
    return { lanes, unreadable };
  }

  async open(): Promise<Lane[]> {
    return (await this.list()).filter((l) => statusOf(l) !== "closed");
  }

  async byPane(pane: string): Promise<Lane | null> {
    return (await this.open()).find((l) => l.pane === pane) ?? null;
  }
}
