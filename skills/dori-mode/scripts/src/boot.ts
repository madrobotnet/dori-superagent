import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { shellQuote } from "./launch.ts";
import { listPanes, type Pane } from "./panes.ts";
import type { Slack } from "./messenger/slack.ts";
import { type Lane, statusOf } from "./registry.ts";
import { type ProgressState, ReportError, Reports } from "./reports.ts";

export type PaneState = "live" | "vanished" | "unassigned";
export type Monitor = {
  readonly monitorId?: string;
  readonly sessionId?: string;
  readonly persistent?: boolean;
  readonly suspended?: boolean;
  /** Epoch ms after which the runtime ends the watch on its own. */
  readonly expiresAt?: number;
  readonly deliveryPaused?: boolean;
  readonly description?: string;
  readonly command?: string;
  readonly path?: string;
  readonly target?: string;
};
export type Manifest = { readonly path: string; readonly data: { readonly version: number; readonly sessionId: string; readonly monitors: readonly Monitor[] } };
export type BootLane = Lane & { readonly reportState?: ProgressState };
export type Cleanup = { readonly monitorId: string; readonly sessionId: string; readonly metadata: string; readonly lanes: readonly string[]; readonly match: readonly string[]; readonly suspended: boolean; readonly deliveryPaused: boolean; readonly expiresAt?: number; readonly stop: string };
export type SlackCheck = () => Promise<{ readonly userId: string; readonly teamId: string } | null>;
export type BootDeps = Pick<FlowDeps, "run" | "registry" | "config" | "clock"> & {
  readonly reports: Reports;
  /** null when no Slack token is configured; boot then skips the check. */
  readonly slack: SlackCheck;
  readonly monitorDirs?: readonly string[];
  /** How long the Slack step may take; withBackoff alone can retry for minutes. */
  readonly slackDeadlineMs?: number;
};

// The one definition of a finished lane, shared by the VANISHED filter and the cleanup check.
const finished = (lane: BootLane): boolean => ["closed", "verified-done"].includes(statusOf(lane)) || lane.reportState === "done";

/** The boot Slack step: auth.test through the given client, or null (skipped) when no token is configured. */
export const slackAuthCheck = (slack: Pick<Slack, "call"> | null): SlackCheck => async () => {
  if (!slack) return null;
  const auth = await slack.call("auth.test", {});
  // A success without both ids proves nothing about the account, as in `inbound`.
  if (typeof auth.user_id !== "string" || !auth.user_id || typeof auth.team_id !== "string" || !auth.team_id) throw new Error("auth.test returned no user_id or team_id");
  return { userId: auth.user_id, teamId: auth.team_id };
};

export const reconcilePanes = (lanes: readonly Lane[], panes: readonly Pane[]): { lanes: { key: string; status: string; pane: string | null; paneState: PaneState }[]; unregistered: string[] } => {
  const live = new Set(panes.map((pane) => pane.pane_id));
  // A closed lane owns no pane: one left open by a failed close is unregistered, as in sync.
  const registered = new Set(lanes.flatMap((lane) => (lane.pane && statusOf(lane) !== "closed" ? [lane.pane] : [])));
  return {
    lanes: lanes.map((lane) => ({
      key: lane.key, status: statusOf(lane), pane: lane.pane ?? null,
      paneState: !lane.pane ? "unassigned" : live.has(lane.pane) ? "live" : "vanished",
    })),
    unregistered: panes.filter((pane) => !registered.has(pane.pane_id)).map((pane) => pane.pane_id),
  };
};

// Loose: any mention of a name, prose and paths included. Used only to keep a watch that might belong to an open lane.
// A colon or a period next to the name is punctuation ("lane:api-release", "api-release.") unless the period joins
// another name ("api.v2" is not "v2").
const mentions = (text: string, value: string | undefined): boolean => {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9_-])(?<![a-zA-Z0-9_-]\\.)${escaped}(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`).test(text);
};

// Strict: the evidence that ties a watch to a lane is the lane's pane id or its key as a whole argv token of the
// command or target. A description is prose and a path segment is not the lane ("build/docs/out.log" is not "docs").
const TIED_FIELDS = ["command", "target"] as const;
const tokens = (value: unknown): string[] => (typeof value === "string" ? value.split(/\s+/).map((t) => t.replace(/^['"]+|['"]+$/g, "")).filter(Boolean) : []);
const tiedBy = (monitor: Monitor, lane: Lane): string | null => {
  for (const field of TIED_FIELDS) {
    const words = tokens(monitor[field]);
    if (lane.pane && words.includes(lane.pane)) return `${lane.key}:${field}:pane`;
    if (words.includes(lane.key)) return `${lane.key}:${field}:key`;
  }
  return null;
};

export const monitorCleanup = (lanes: readonly BootLane[], manifests: readonly Manifest[]): Cleanup[] => {
  const cleanup: Cleanup[] = [];
  for (const { path, data } of manifests) {
    for (const monitor of data.monitors) {
      if (!monitor.persistent || !/^mon_[A-Za-z0-9]+$/.test(monitor.monitorId ?? "")) continue;
      if (monitor.sessionId !== data.sessionId) continue;
      const tied = lanes.flatMap((lane) => {
        const match = tiedBy(monitor, lane);
        return match ? [{ lane, match }] : [];
      });
      if (!tied.length || tied.some(({ lane }) => !finished(lane))) continue;
      // Any mention of an open lane anywhere in the watch keeps it.
      const text = [monitor.description, monitor.command, monitor.path, monitor.target].filter((v) => typeof v === "string").join("\n");
      if (lanes.some((lane) => !finished(lane) && (mentions(text, lane.key) || mentions(text, lane.pane)))) continue;
      const monitorId = monitor.monitorId ?? "";
      cleanup.push({
        monitorId, sessionId: data.sessionId, metadata: path, lanes: tied.map(({ lane }) => lane.key), match: tied.map(({ match }) => match),
        suspended: Boolean(monitor.suspended), deliveryPaused: monitor.deliveryPaused === true,
        ...(typeof monitor.expiresAt === "number" ? { expiresAt: monitor.expiresAt } : {}),
        stop: `kill_bash(${JSON.stringify({ bash_id: monitorId })})`,
      });
    }
  }
  return cleanup;
};

const entries = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
};

// One unreadable file is named in errors and skipped; the other sessions' metadata is still read.
export const readMonitorManifests = (sessionsDir: string, extraDirs: readonly string[] = []): { manifests: Manifest[]; errors: string[] } => {
  const dirs = new Set(extraDirs);
  const manifests: Manifest[] = [];
  const errors: string[] = [];
  try {
    for (const entry of entries(sessionsDir)) if (entry.isDirectory()) dirs.add(join(sessionsDir, entry.name, "extensions", "terminal"));
  } catch {
    errors.push(sessionsDir);
  }
  for (const dir of [...dirs].sort()) {
    let files;
    try {
      files = entries(dir);
    } catch {
      errors.push(dir);
      continue;
    }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(dir, entry.name);
      try {
        const data = JSON.parse(readFileSync(path, "utf8")) as Manifest["data"];
        if (data.version !== 1 || !Array.isArray(data.monitors) || typeof data.sessionId !== "string") throw new Error("invalid monitor metadata");
        // A null or non-object entry makes the whole file unreadable here, never a crash in the cleanup pass.
        if (!data.monitors.every((m: unknown) => typeof m === "object" && m !== null && !Array.isArray(m))) throw new Error("invalid monitor entry");
        manifests.push({ path, data });
      } catch {
        errors.push(path);
      }
    }
  }
  return { manifests, errors };
};

/**
 * Read-only recovery check after a restart or compaction: messenger auth, lanes whose pane vanished, panes no lane
 * owns, each lane's journal state, and persistent watches left on finished lanes. It changes nothing: no registry
 * write, no relaunch, no stopped watch. Exit 1 when any input could not be read.
 */
export const bootCheck = async (deps: BootDeps): Promise<{ exitCode: number; lines: string[] }> => {
  const lines: string[] = [];
  let failed = false;
  const lanes: BootLane[] = [];
  const journals: string[] = [];
  // An unreadable lane file, or a lanes path that cannot be listed, is named; the other lanes and checks still run.
  let registered: Lane[] = [];
  try {
    const scanned = await deps.registry.scan();
    registered = scanned.lanes;
    for (const path of scanned.unreadable) {
      failed = true;
      lines.push(`REGISTRY unreadable ${shellQuote(path)}`);
    }
  } catch {
    failed = true;
    lines.push(`REGISTRY unreadable ${shellQuote(deps.registry.dir)}`);
  }
  for (const lane of registered.sort((a, b) => a.key.localeCompare(b.key))) {
    // Only launched lanes report through the journal, as in freshness; an adopted lane's records are not its state.
    if (lane.reportProtocol !== "jsonl-v1") {
      lanes.push(lane);
      continue;
    }
    try {
      const progress = deps.reports.read(lane.key);
      lanes.push({ ...lane, reportState: progress?.state });
      // The launch's activity record and screen-derived stalls are written by dori, not the lane: only a report is one.
      const report = progress?.lastReport;
      if (report) journals.push(`REPORT ${lane.key} kind=${report.kind} at=${report.at} state=${progress.state} registryStatus=${statusOf(lane)}`);
      else if (progress) journals.push(`NO-REPORT ${lane.key} state=${progress.state} registryStatus=${statusOf(lane)} (journal holds harness activity only)`);
      else journals.push(`NO-REPORT ${lane.key} registryStatus=${statusOf(lane)} (no journal)`);
    } catch (e) {
      // Any unreadable journal is that lane's error; the other lanes are still checked. The message can carry a local
      // path, so only the error kind is printed.
      failed = true;
      const code = (e as NodeJS.ErrnoException | null)?.code;
      const kind = e instanceof ReportError ? "invalid-journal" : typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unreadable";
      journals.push(`JOURNAL-ERROR ${lane.key} kind=${kind}`);
      lanes.push(lane);
    }
  }
  // A failed pane list is not an empty one: never call every lane vanished.
  let panes: Pane[] | null = null;
  try {
    panes = await listPanes(deps.run);
  } catch {
    failed = true;
    lines.push("PANES unavailable (herdr pane list failed)");
  }
  if (panes) {
    const result = reconcilePanes(lanes, panes);
    const lead = deps.config.leadPane;
    // A finished lane (closed, verified-done, or a done journal) is done with its pane, as in cleanup; only the others are worth flagging.
    const done = new Set(lanes.filter(finished).map((lane) => lane.key));
    const vanished = result.lanes.filter((lane) => lane.paneState === "vanished" && !done.has(lane.key));
    lines.push(`PANES lead=${lead || "unconfigured"} leadState=${panes.some((p) => p.pane_id === lead) ? "live" : "missing"} registeredLive=${result.lanes.filter((l) => l.paneState === "live" && l.status !== "closed").length} vanished=${vanished.length} unregistered=${result.unregistered.length}`);
    for (const lane of vanished) lines.push(`VANISHED ${lane.key} pane=${lane.pane} status=${lane.status}; registry and worktrees preserved; no relaunch`);
    if (result.unregistered.length) lines.push(`UNREGISTERED ${result.unregistered.join(" ")}`);
  }
  lines.push(...journals);
  const { manifests, errors } = readMonitorManifests(deps.config.sessionsDir, deps.monitorDirs);
  for (const path of errors) {
    failed = true;
    lines.push(`MONITORS unreadable ${shellQuote(path)}`);
  }
  const cleanup = monitorCleanup(lanes, manifests);
  // Live watches first, then delivery-paused ones (still running, so still stopped); an expired watch has ended on its
  // own and gets no stop call.
  const now = deps.clock.now();
  const expired = cleanup.filter((item) => item.expiresAt !== undefined && item.expiresAt <= now);
  const running = cleanup.filter((item) => !expired.includes(item));
  const ordered = [...running.filter((item) => !item.deliveryPaused), ...running.filter((item) => item.deliveryPaused)];
  lines.push(`MONITORS cleanupCandidates=${running.length} deliveryPaused=${running.filter((item) => item.deliveryPaused).length} expired=${expired.length} (from metadata; liveness unverified)`);
  for (const item of ordered) {
    lines.push(`CLEANUP ${item.lanes.join(",")} match=${item.match.join(",")} ownerSession=${item.sessionId} metadata=${shellQuote(item.metadata)}${item.suspended ? " suspended=true" : ""}${item.deliveryPaused ? " deliveryPaused=true" : ""}`);
    lines.push(`STOP in the owner session only: ${item.stop}`);
  }
  for (const item of expired) {
    lines.push(`EXPIRED ${item.lanes.join(",")} match=${item.match.join(",")} ownerSession=${item.sessionId} metadata=${shellQuote(item.metadata)} expiresAt=${new Date(item.expiresAt ?? 0).toISOString()}; nothing to stop`);
  }
  // The network step runs last, after every local check, and gives up at a short deadline.
  const deadlineMs = deps.slackDeadlineMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const auth = await Promise.race([deps.slack(), new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), deadlineMs); })]);
    if (auth === "timeout") {
      failed = true;
      lines.push(`SLACK auth.test timed out after ${deadlineMs} ms`);
    } else lines.push(auth ? `SLACK authenticated user=${auth.userId} team=${auth.teamId} (auth.test only; inbox delivery unverified)` : "SLACK skipped (DORI_SLACK_TOKEN not set)");
  } catch {
    failed = true;
    lines.push("SLACK auth failed");
  } finally {
    clearTimeout(timer);
  }
  lines.push(`BOOT ${failed ? "incomplete" : "checked"} read-only; nothing restarted, written or stopped`);
  return { exitCode: failed ? 1 : 0, lines };
};
