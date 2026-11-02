import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bootCheck, type Manifest, type Monitor, monitorCleanup, readMonitorManifests, reconcilePanes } from "../src/boot.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const lane = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({
  key, status, pane, title: key, thread: "none", brief: "/b.md", done: "file /done.md", openedAt: new Date(T0).toISOString(),
});
const launched = (key: string, status: LaneStatus = "working", pane = `w1:${key}`): Lane => ({ ...lane(key, status, pane), reportProtocol: "jsonl-v1" });
const manifest = (monitors: Monitor[]): Manifest => ({
  path: "/fixture/extensions/terminal/owner.json",
  data: { version: 1, sessionId: "owner", monitors: monitors.map((m) => ({ sessionId: "owner", persistent: true, monitorId: "mon_FIXTURE", ...m })) },
});

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, fakeClock(T0), state.dir, { sessionsDir, leadPane: "w2:p1" });
  return { ...deps, reports: new Reports(state.dir), slack, sessionsDir };
};

test("vanished, live and unassigned panes reconcile without mutating the lane records", () => {
  // Given lanes whose panes are gone, live, or never assigned.
  const lanes = [lane("old", "working", "w1:p8"), lane("current", "working", "w2:p2"), { ...lane("pending"), pane: undefined }];
  const before = JSON.stringify(lanes);
  // When reconciled against the live pane list.
  const result = reconcilePanes(lanes, [{ pane_id: "w2:p1", workspace_id: "w2" }, { pane_id: "w2:p2", workspace_id: "w2" }]);
  // Then each lane is classified, unowned panes are listed, and the input is untouched.
  expect(result.lanes.map((l) => l.paneState)).toEqual(["vanished", "live", "unassigned"]);
  expect(result.unregistered).toEqual(["w2:p1"]);
  expect(JSON.stringify(lanes)).toBe(before);
});

test("persistent watches on closed or verified lanes become owner-scoped stop calls", () => {
  // Given watches for closed, verified and still-claimed lanes, plus a non-persistent one.
  const lanes = [lane("closed", "closed"), lane("verified", "verified-done"), lane("claimed", "done-claimed")];
  const input = manifest([
    { description: "closed reports", monitorId: "mon_CLOSED" },
    { command: "herdr pane read w1:verified", monitorId: "mon_VERIFIED" },
    { description: "claimed reports", monitorId: "mon_CLAIMED" },
    { description: "closed reports", monitorId: "mon_EPHEMERAL", persistent: false },
  ]);
  // When cleanup candidates are computed.
  const result = monitorCleanup(lanes, [input]);
  // Then only persistent watches of finished lanes are listed, with the owner's exact stop call.
  expect(result.map((m) => m.monitorId)).toEqual(["mon_CLOSED", "mon_VERIFIED"]);
  expect(result[0]?.stop).toBe('kill_bash({"bash_id":"mon_CLOSED"})');
  expect(result[0]?.sessionId).toBe("owner");
  expect(result[0]?.metadata).toBe(input.path);
});

test("shared, prefix-matched, unknown and foreign-owner watches are preserved", () => {
  // Given a closed lane whose key is a prefix of an active one, and watches of every risky shape.
  const lanes = [lane("api", "closed"), lane("api-release"), lane("closed", "closed")];
  const result = monitorCleanup(lanes, [manifest([
    { description: "api-release reports", monitorId: "mon_ACTIVE" },
    { description: "closed and api-release reports", monitorId: "mon_SHARED" },
    { description: "unrelated presence", monitorId: "mon_UNKNOWN" },
    { description: "closed reports", sessionId: "other", monitorId: "mon_WRONGOWNER" },
  ])]);
  // Then none is offered for cleanup.
  expect(result).toEqual([]);
});

test("an active lane named after a colon or before a period or colon still keeps a shared watch", () => {
  // Given a closed lane, an active one, and a closed key that appears only inside a dotted name.
  const lanes = [lane("closed", "closed"), lane("api-release"), lane("v2", "closed")];
  const result = monitorCleanup(lanes, [manifest([
    { description: "closed reports; lane:api-release", monitorId: "mon_COLON" },
    { description: "closed reports, then api-release.", monitorId: "mon_PERIOD" },
    { description: "closed and api-release: both", monitorId: "mon_TRAILCOLON" },
    { description: "watch api.v2 only", monitorId: "mon_DOTTED" },
    { description: "closed reports", monitorId: "mon_CLOSED" },
  ])]);
  // Then only the watch naming nothing but the closed lane is offered.
  expect(result.map((m) => m.monitorId)).toEqual(["mon_CLOSED"]);
});

test("a done journal qualifies a lane for cleanup on its own; halted does not", () => {
  // Given two working lanes whose journals say done and halted.
  const lanes = [{ ...lane("done-report"), reportState: "done" as const }, { ...lane("halted-report"), reportState: "halted" as const }];
  // When cleanup candidates are computed.
  const cleanup = monitorCleanup(lanes, [manifest([
    { description: "done-report reports", monitorId: "mon_DONE" },
    { description: "halted-report reports", monitorId: "mon_HALTED" },
  ])]);
  // Then only the done lane's watch is listed.
  expect(cleanup.map((m) => m.monitorId)).toEqual(["mon_DONE"]);
});

test("metadata discovery reads only terminal JSON, never transcripts or nested state", () => {
  // Given a session directory with a transcript, nested state and one manifest.
  const root = join(state.dir, "sessions");
  const terminal = join(root, "project", "extensions", "terminal");
  mkdirSync(join(terminal, "state"), { recursive: true });
  writeFileSync(join(root, "project", "session.jsonl"), "not JSON: never inspect");
  writeFileSync(join(terminal, "state", "private.json"), "not JSON: never inspect");
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([]).data));
  // When manifests are read; then only the manifest is.
  const read = readMonitorManifests(root);
  expect(read.manifests.map((m) => m.path)).toEqual([join(terminal, "owner.json")]);
  expect(read.errors).toEqual([]);
});

test("boot reports vanished panes, journals and stale watches, and writes nothing", async () => {
  // Given a lane whose pane vanished, a live lane, a closed lane with a watch, and a halted journal.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, { pane_id: "w2:p2", workspace_id: "w2" }];
  const deps = bootDeps(world, async () => ({ userId: "U_FIXTURE", teamId: "T_FIXTURE" }));
  for (const l of [launched("api-release", "working", "w1:p8"), lane("live", "working", "w2:p2"), lane("closed", "closed")]) await deps.registry.write(l);
  deps.reports.report("api-release", "halted", "work pushed, waiting for the owner", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ description: "closed reports", monitorId: "mon_REALFIXTURE" }]).data));
  const snapshot = () => readdirSync(state.dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => [join(e.parentPath, e.name), readFileSync(join(e.parentPath, e.name), "utf8")]);
  const before = snapshot();
  // When boot runs.
  const result = await bootCheck(deps);
  // Then every finding is printed, the exit is clean, and no file changed.
  expect(result.exitCode).toBe(0);
  expect(result.lines[0]).toBe("SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)");
  expect(result.lines).toContain("VANISHED api-release pane=w1:p8 status=working; registry and worktrees preserved; no relaunch");
  expect(result.lines).toContain("UNREGISTERED w2:p1");
  expect(result.lines).toContain("REPORT api-release kind=halted at=2026-01-01T12:00:00.000Z state=halted registryStatus=working");
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_REALFIXTURE"})');
  expect(result.lines.some((l) => l.startsWith("VANISHED closed"))).toBe(false);
  expect(snapshot()).toEqual(before);
  expect(world.calls.every((c) => c[0] === "herdr" && c[1] === "pane" && c[2] === "list")).toBe(true);
});

test("a closed lane owns no pane, so a pane left behind by a failed close is unregistered", async () => {
  // Given a closed lane whose pane is still open, and a working lane on a live pane.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }, { pane_id: "w2:p2", workspace_id: "w2" }, { pane_id: "w2:p3", workspace_id: "w2" }];
  const deps = bootDeps(world);
  await deps.registry.write(lane("gone", "closed", "w2:p3"));
  await deps.registry.write(lane("current", "working", "w2:p2"));
  // When boot runs; then the leftover pane is listed and only the open lane counts as registered.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=1 vanished=0 unregistered=2");
  expect(result.lines).toContain("UNREGISTERED w2:p1 w2:p3");
});

test("a failed pane list stays unknown instead of declaring every lane vanished", async () => {
  // Given herdr failing to list panes.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("active"));
  const failing = { ...deps, run: async () => ({ code: 1, out: "", err: "server not running" }) };
  // When boot runs; then it is incomplete and no lane is called vanished.
  const result = await bootCheck(failing);
  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain("PANES unavailable (herdr pane list failed)");
  expect(result.lines.some((line) => line.startsWith("VANISHED"))).toBe(false);
});

test("Slack is optional, and a failed check never prints the provider error", async () => {
  // Given no token, then a token whose auth.test fails with a secret-looking message.
  const world = newWorld();
  const skipped = await bootCheck(bootDeps(world));
  const failed = await bootCheck(bootDeps(world, async () => { throw new Error("FIXTURE_TOKEN"); }));
  // Then a missing token is a skip, and a failure is incomplete without the error text.
  expect(skipped.lines[0]).toBe("SLACK skipped (DORI_SLACK_TOKEN not set)");
  expect(skipped.exitCode).toBe(0);
  expect(failed.lines[0]).toBe("SLACK auth failed");
  expect(failed.exitCode).toBe(1);
  expect(failed.lines.join("\n")).not.toContain("FIXTURE_TOKEN");
});

test("a corrupt journal is reported for its lane and does not stop the check", async () => {
  // Given a lane whose journal ends in a partial write.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("broken"));
  deps.reports.report("broken", "milestone", "started", T0);
  writeFileSync(deps.reports.path("broken"), `${readFileSync(deps.reports.path("broken"), "utf8")}{partial\n`);
  // When boot runs; then the lane is named, the rest still runs, and the exit is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => l.startsWith("JOURNAL-ERROR broken:"))).toBe(true);
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("the launch's activity record is not a report: a lane that never reported reads NO-REPORT", async () => {
  // Given a launched lane whose journal holds only the harness's launch activity.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("quiet"));
  deps.reports.append({ type: "activity", key: "quiet", at: new Date(T0).toISOString(), state: "running", text: "lane launched in w1:quiet" });
  // When boot runs; then the lane is listed as having no report, never with a REPORT line.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("NO-REPORT quiet state=running registryStatus=working (journal holds harness activity only)");
  expect(result.lines.some((l) => l.startsWith("REPORT quiet"))).toBe(false);
});

test("an adopted lane's journal is not read, so a done record there cannot offer its watch for cleanup", async () => {
  // Given an adopted lane (no reportProtocol) with a done record and a persistent watch naming it.
  const world = newWorld();
  world.panes = [{ pane_id: "w1:adopted", workspace_id: "w1" }];
  const deps = bootDeps(world);
  await deps.registry.write(lane("adopted"));
  deps.reports.report("adopted", "done", "finished", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ description: "adopted reports", monitorId: "mon_ADOPTED" }]).data));
  // When boot runs; then the journal is ignored like freshness ignores it, and the watch is kept.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => /^(NO-)?REPORT adopted/.test(l))).toBe(false);
  expect(result.lines).toContain("MONITORS cleanupCandidates=0 (from metadata; liveness unverified)");
  expect(result.exitCode).toBe(0);
});

test("an unreadable journal of any kind is that lane's error; the other lanes are still reported", async () => {
  // Given one lane whose journal path is a directory (not a ReportError) and one healthy lane.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("a-broken"));
  await deps.registry.write(launched("b-healthy"));
  mkdirSync(deps.reports.path("a-broken"), { recursive: true });
  deps.reports.report("b-healthy", "blocker", "needs the owner", T0);
  // When boot runs; then both lanes are listed and the run finishes incomplete.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => l.startsWith("JOURNAL-ERROR a-broken:"))).toBe(true);
  expect(result.lines).toContain("REPORT b-healthy kind=blocker at=2026-01-01T12:00:00.000Z state=blocked registryStatus=working");
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("a manifest with a malformed monitor entry is named as unreadable and the check still finishes", async () => {
  // Given one manifest whose monitors list holds null and a string, and a valid manifest in another session.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const bad = join(deps.sessionsDir, "a", "extensions", "terminal");
  const good = join(deps.sessionsDir, "b", "extensions", "terminal");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  writeFileSync(join(bad, "null.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: [null] }));
  writeFileSync(join(bad, "string.json"), JSON.stringify({ version: 1, sessionId: "owner", monitors: ["mon_X"] }));
  writeFileSync(join(good, "owner.json"), JSON.stringify(manifest([{ description: "closed reports", monitorId: "mon_GOOD" }]).data));
  // When boot runs; then both bad files are named, the good watch is still listed, and the run is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "null.json")}`);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "string.json")}`);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});

test("one unreadable metadata file is named and the other sessions' cleanup is still listed, path quoted", async () => {
  // Given a corrupt manifest in one session and a valid one, in a directory with a space, in another.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const bad = join(deps.sessionsDir, "a", "extensions", "terminal");
  const good = join(deps.sessionsDir, "b session", "extensions", "terminal");
  mkdirSync(bad, { recursive: true });
  mkdirSync(good, { recursive: true });
  writeFileSync(join(bad, "owner.json"), "{partial");
  writeFileSync(join(good, "owner.json"), JSON.stringify(manifest([{ description: "closed reports", monitorId: "mon_GOOD" }]).data));
  // When boot runs.
  const result = await bootCheck(deps);
  // Then the bad file is named, the good one still yields its stop call, and its path is shell-quoted.
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "owner.json")}`);
  expect(result.lines).toContain(`CLEANUP closed ownerSession=owner metadata='${join(good, "owner.json")}'`);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});
