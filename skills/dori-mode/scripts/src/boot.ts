import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "./done-flow.ts";
import { shellQuote } from "./launch.ts";
import { listPanes, type Pane } from "./panes.ts";
import { type Lane, statusOf } from "./registry.ts";
import { type ProgressState, Reports } from "./reports.ts";

export type PaneState = "live" | "vanished" | "unassigned";
export type Monitor = {
  readonly monitorId?: string;
  readonly sessionId?: string;
  readonly persistent?: boolean;
  readonly suspended?: boolean;
  readonly description?: string;
  readonly command?: string;
  readonly path?: string;
  readonly target?: string;
};
export type Manifest = { readonly path: string; readonly data: { readonly version: number; readonly sessionId: string; readonly monitors: readonly Monitor[] } };
export type BootLane = Lane & { readonly reportState?: ProgressState };
export type Cleanup = { readonly monitorId: string; readonly sessionId: string; readonly metadata: string; readonly lanes: readonly string[]; readonly suspended: boolean; readonly stop: string };
export type SlackCheck = () => Promise<{ readonly userId: string; readonly teamId: string } | null>;
export type BootDeps = Pick<FlowDeps, "run" | "registry" | "config"> & {
  readonly reports: Reports;
  /** null when no Slack token is configured; boot then skips the check. */
  readonly slack: SlackCheck;
  readonly monitorDirs?: readonly string[];
};

const finished = (lane: BootLane): boolean => ["closed", "verified-done"].includes(statusOf(lane)) || lane.reportState === "done";

export const reconcilePanes = (lanes: readonly Lane[], panes: readonly Pane[]): { lanes: { key: string; status: string; pane: string | null; paneState: PaneState }[]; unregistered: string[] } => {
  const live = new Set(panes.map((pane) => pane.pane_id));
  const registered = new Set(lanes.flatMap((lane) => (lane.pane ? [lane.pane] : [])));
  return {
    lanes: lanes.map((lane) => ({
      key: lane.key, status: statusOf(lane), pane: lane.pane ?? null,
      paneState: !lane.pane ? "unassigned" : live.has(lane.pane) ? "live" : "vanished",
    })),
    unregistered: panes.filter((pane) => !registered.has(pane.pane_id)).map((pane) => pane.pane_id),
  };
};

// An exact lane or pane reference, never a prefix such as "api" in "api-release" or "api" in "api.v2". A colon or a
// period next to the name is punctuation ("lane:api-release", "api-release.") unless the period joins another name.
const mentions = (text: string, value: string | undefined): boolean => {
  if (!value) return false;
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-zA-Z0-9_-])(?<![a-zA-Z0-9_-]\\.)${escaped}(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`).test(text);
};

export const monitorCleanup = (lanes: readonly BootLane[], manifests: readonly Manifest[]): Cleanup[] => {
  const cleanup: Cleanup[] = [];
  for (const { path, data } of manifests) {
    for (const monitor of data.monitors) {
      if (!monitor.persistent || !/^mon_[A-Za-z0-9]+$/.test(monitor.monitorId ?? "")) continue;
      if (monitor.sessionId !== data.sessionId) continue;
      const text = [monitor.description, monitor.command, monitor.path, monitor.target].filter(Boolean).join("\n");
      const matched = lanes.filter((lane) => mentions(text, lane.key) || mentions(text, lane.pane));
      if (!matched.length || matched.some((lane) => !finished(lane))) continue;
      const monitorId = monitor.monitorId ?? "";
      cleanup.push({
        monitorId, sessionId: data.sessionId, metadata: path, lanes: matched.map((lane) => lane.key),
        suspended: Boolean(monitor.suspended), stop: `kill_bash(${JSON.stringify({ bash_id: monitorId })})`,
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
  try {
    const auth = await deps.slack();
    lines.push(auth ? `SLACK authenticated user=${auth.userId} team=${auth.teamId} (auth.test only; inbox delivery unverified)` : "SLACK skipped (DORI_SLACK_TOKEN not set)");
  } catch {
    failed = true;
    lines.push("SLACK auth failed");
  }
  const lanes: BootLane[] = [];
  const journals: string[] = [];
  for (const lane of (await deps.registry.list()).sort((a, b) => a.key.localeCompare(b.key))) {
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
    } catch (e) {
      // Any unreadable journal is that lane's error; the other lanes are still checked.
      failed = true;
      journals.push(`JOURNAL-ERROR ${lane.key}: ${e instanceof Error ? e.message : String(e)}`);
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
    const vanished = result.lanes.filter((lane) => lane.paneState === "vanished" && lane.status !== "closed");
    lines.push(`PANES lead=${lead || "unconfigured"} leadState=${panes.some((p) => p.pane_id === lead) ? "live" : "missing"} registeredLive=${result.lanes.filter((l) => l.paneState === "live").length} vanished=${vanished.length} unregistered=${result.unregistered.length}`);
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
  lines.push(`MONITORS cleanupCandidates=${cleanup.length} (from metadata; liveness unverified)`);
  for (const item of cleanup) {
    lines.push(`CLEANUP ${item.lanes.join(",")} ownerSession=${item.sessionId} metadata=${shellQuote(item.metadata)}${item.suspended ? " suspended=true" : ""}`);
    lines.push(`STOP in the owner session only: ${item.stop}`);
  }
  lines.push(`BOOT ${failed ? "incomplete" : "checked"} read-only; nothing restarted, written or stopped`);
  return { exitCode: failed ? 1 : 0, lines };
};
