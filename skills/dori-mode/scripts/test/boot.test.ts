import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { bootCheck, type Manifest, type Monitor, monitorCleanup, readMonitorManifests, reconcilePanes, slackAuthCheck } from "../src/boot.ts";
import { Slack } from "../src/messenger/slack.ts";
import { type Lane, type LaneStatus, Registry } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { Worklog } from "../src/worklog.ts";
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

// Every directory and file under the state dir, with file bytes, so a created directory counts as a write too.
const snapshot = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .map((e) => [join(e.parentPath, e.name), e.isFile() ? readFileSync(join(e.parentPath, e.name), "utf8") : e.isDirectory() ? "<dir>" : "<other>"])
  .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));

const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const sessionsDir = join(state.dir, "sessions");
  const deps = depsFor(world, fakeClock(T0), state.dir, { sessionsDir, leadPane: "w2:p1" });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack, sessionsDir };
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
    { command: "dori watch closed", monitorId: "mon_CLOSED" },
    { command: "herdr pane read w1:verified", monitorId: "mon_VERIFIED" },
    { command: "dori watch claimed", monitorId: "mon_CLAIMED" },
    { command: "dori watch closed", monitorId: "mon_EPHEMERAL", persistent: false },
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
    { command: "dori watch api-release", monitorId: "mon_ACTIVE" },
    { command: "dori watch closed api-release", monitorId: "mon_SHARED" },
    { description: "unrelated presence", command: "bun presence.ts", monitorId: "mon_UNKNOWN" },
    { command: "dori watch closed", sessionId: "other", monitorId: "mon_WRONGOWNER" },
  ])]);
  // Then none is offered for cleanup.
  expect(result).toEqual([]);
});

test("an active lane named after a colon or before a period or colon still keeps a shared watch", () => {
  // Given a closed lane, an active one, and a closed key that appears only inside a dotted name.
  const lanes = [lane("closed", "closed"), lane("api-release"), lane("v2", "closed")];
  const result = monitorCleanup(lanes, [manifest([
    { command: "dori watch closed", description: "closed reports; lane:api-release", monitorId: "mon_COLON" },
    { command: "dori watch closed", description: "closed reports, then api-release.", monitorId: "mon_PERIOD" },
    { command: "dori watch closed", path: "/logs/api-release: both", monitorId: "mon_TRAILCOLON" },
    { command: "dori watch api.v2", monitorId: "mon_DOTTED" },
    { command: "dori watch closed", monitorId: "mon_CLOSED" },
  ])]);
  // Then only the watch naming nothing but the closed lane is offered.
  expect(result.map((m) => m.monitorId)).toEqual(["mon_CLOSED"]);
});

test("a common-word key ties a watch to its lane only as a command or target token, never in prose or a path", () => {
  // Given a closed lane keyed "docs" and watches that name it in prose, in a path, as a token and by pane.
  const lanes = [lane("docs", "closed")];
  const result = monitorCleanup(lanes, [manifest([
    { description: "CI for the docs site on main", command: "gh run watch 4242", monitorId: "mon_PROSE" },
    { description: "build log", command: "tail -F build/docs/out.log", monitorId: "mon_PATH" },
    { description: "lane reports", command: "dori report-watch 'docs'", monitorId: "mon_KEY" },
    { description: "lane screen", target: "w1:docs", monitorId: "mon_PANE" },
  ])]);
  // Then only the token and pane watches are offered, each with the field that matched.
  expect(result.map((m) => [m.monitorId, m.match])).toEqual([["mon_KEY", ["docs:command:key"]], ["mon_PANE", ["docs:target:pane"]]]);
});

test("a done journal qualifies a lane for cleanup on its own; halted does not", () => {
  // Given two working lanes whose journals say done and halted.
  const lanes = [{ ...lane("done-report"), reportState: "done" as const }, { ...lane("halted-report"), reportState: "halted" as const }];
  // When cleanup candidates are computed.
  const cleanup = monitorCleanup(lanes, [manifest([
    { command: "dori watch done-report", monitorId: "mon_DONE" },
    { command: "dori watch halted-report", monitorId: "mon_HALTED" },
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
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_REALFIXTURE" }]).data));
  const before = snapshot(state.dir);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then every finding is printed, the exit is clean, and no file changed.
  expect(result.exitCode).toBe(0);
  expect(result.lines).toContain("SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)");
  expect(result.lines).toContain("VANISHED api-release pane=w1:p8 status=working; registry and worktrees preserved; no relaunch");
  expect(result.lines).toContain("UNREGISTERED w2:p1");
  expect(result.lines).toContain("REPORT api-release kind=halted at=2026-01-01T12:00:00.000Z state=halted registryStatus=working");
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_REALFIXTURE"})');
  expect(result.lines.some((l) => l.startsWith("VANISHED closed"))).toBe(false);
  expect(snapshot(state.dir)).toEqual(before);
  expect(world.calls.every((c) => c[0] === "herdr" && c[1] === "pane" && c[2] === "list")).toBe(true);
});

test("boot on a state dir with no lanes directory leaves it byte-identical", async () => {
  // Given a state dir that has never held a lane.
  const world = newWorld();
  const deps = bootDeps(world);
  writeFileSync(join(state.dir, "messenger.json"), "{}");
  const before = snapshot(state.dir);
  // When boot runs; then it finishes clean and creates no lanes directory or anything else.
  const result = await bootCheck(deps);
  expect(result.exitCode).toBe(0);
  expect(snapshot(state.dir)).toEqual(before);
});

test("boot prints each open worklog item with its Next line, skips closed ones, and writes nothing", async () => {
  // Given one item with a next step, one without, and one closed.
  const world = newWorld();
  const deps = bootDeps(world);
  const release = deps.worklog.add("Ship the release notes", "slack:D1/100.1", T0);
  deps.worklog.next(release.id, "wait for CI on #12, then merge", T0 + 1);
  const fresh = deps.worklog.add("Look at the flaky upload test", "slack:D1/100.2", T0 + 2);
  const old = deps.worklog.add("Rename the bot", "slack:D1/100.3", T0 + 3);
  deps.worklog.close(old.id, "renamed; owner confirmed", T0 + 4);
  const before = snapshot(state.dir);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then the open items are listed oldest first with their Next line, the closed one is absent, and no file changed.
  expect(result.exitCode).toBe(0);
  const at = result.lines.indexOf("WORKLOG open=2");
  expect(result.lines.slice(at, at + 3)).toEqual([
    "WORKLOG open=2",
    `OPEN ${release.id} "Ship the release notes" source=slack:D1/100.1 next="wait for CI on #12, then merge"`,
    `OPEN ${fresh.id} "Look at the flaky upload test" source=slack:D1/100.2 next=""`,
  ]);
  expect(result.lines.some((l) => l.includes(old.id))).toBe(false);
  expect(snapshot(state.dir)).toEqual(before);
});

test("a damaged worklog line is named and makes boot incomplete; the other items still print", async () => {
  // Given one item and a torn line after it.
  const deps = bootDeps(newWorld());
  const item = deps.worklog.add("Keep this", "slack:D1/100.1", T0);
  writeFileSync(deps.worklog.path, `${readFileSync(deps.worklog.path, "utf8")}{"op":"add"`);
  // When boot runs; then the item prints, the bad line is named, and the exit is 1.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`OPEN ${item.id} "Keep this" source=slack:D1/100.1 next=""`);
  expect(result.lines).toContain(`WORKLOG damaged ${deps.worklog.path}:2: JSON Parse error: Expected '}'`);
  expect(result.exitCode).toBe(1);
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

test("an unreadable lane file is named and the other lanes are still checked", async () => {
  // Given a partial lane record next to a lane whose pane vanished.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("healthy", "working", "w1:gone"));
  writeFileSync(deps.registry.path("broken"), "{partial");
  writeFileSync(deps.registry.path("null-record"), "null");
  // When boot runs; then the file is named, the healthy lane is still reported, and the run is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${deps.registry.path("broken")}`);
  expect(result.lines).toContain(`REGISTRY unreadable ${deps.registry.path("null-record")}`);
  expect(result.lines).toContain("VANISHED healthy pane=w1:gone status=working; registry and worktrees preserved; no relaunch");
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("a lanes path that cannot be listed is named and the rest of boot still runs", async () => {
  // Given a lanes path that is a file, not a directory.
  const world = newWorld();
  const deps = bootDeps(world);
  writeFileSync(join(state.dir, "lanes"), "not a directory");
  // When boot runs; then the registry is named unreadable and the later checks still print.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${join(state.dir, "lanes")}`);
  expect(result.lines.some((l) => l.startsWith("MONITORS cleanupCandidates="))).toBe(true);
  expect(result.exitCode).toBe(1);
});

test("a verified-done lane whose pane is gone is not flagged VANISHED", async () => {
  // Given a verified-done lane and a working lane, both on panes that no longer exist.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  const deps = bootDeps(world);
  await deps.registry.write(lane("verified", "verified-done", "w1:p7"));
  await deps.registry.write(lane("working", "working", "w1:p8"));
  // When boot runs; then only the working lane is flagged.
  const result = await bootCheck(deps);
  expect(result.lines.filter((l) => l.startsWith("VANISHED"))).toEqual(["VANISHED working pane=w1:p8 status=working; registry and worktrees preserved; no relaunch"]);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=0 vanished=1 unregistered=1");
});

test("a journal-done lane whose pane is gone is finished in both checks: not VANISHED, and its watch is offered for cleanup", async () => {
  // Given a working lane whose journal says done, on a pane that no longer exists, with a persistent watch naming it.
  const world = newWorld();
  world.panes = [{ pane_id: "w2:p1", workspace_id: "w2" }];
  const deps = bootDeps(world);
  await deps.registry.write(launched("reported", "working", "w1:p9"));
  deps.reports.report("reported", "done", "finished", T0);
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ command: "dori watch reported", monitorId: "mon_REPORTED" }]).data));
  // When boot runs; then the lane is not flagged and its watch is a cleanup candidate.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => l.startsWith("VANISHED"))).toBe(false);
  expect(result.lines).toContain("PANES lead=w2:p1 leadState=live registeredLive=0 vanished=0 unregistered=1");
  expect(result.lines).toContain("MONITORS cleanupCandidates=1 deliveryPaused=0 expired=0 (from metadata; liveness unverified)");
  expect(result.lines).toContain("STOP in the owner session only: kill_bash({\"bash_id\":\"mon_REPORTED\"})");
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
  expect(skipped.lines).toContain("SLACK skipped (DORI_SLACK_TOKEN not set)");
  expect(skipped.exitCode).toBe(0);
  expect(failed.lines).toContain("SLACK auth failed");
  expect(failed.exitCode).toBe(1);
  expect(failed.lines.join("\n")).not.toContain("FIXTURE_TOKEN");
});

test("the Slack step reads auth.test through the client and fails when it returns no user or team id", async () => {
  // Given a Slack client whose auth.test succeeds with both ids, then with the team id missing.
  const slackWith = (body: Record<string, unknown>) => {
    const calls: string[] = [];
    const http = async (req: { url: string }) => { calls.push(req.url); return { status: 200, headers: {}, body: JSON.stringify(body) }; };
    return { slack: new Slack(http, fakeClock(T0), { token: "xoxp-FIXTURE" }, "https://slack.test/api"), calls };
  };
  const ok = slackWith({ ok: true, user_id: "U_FIXTURE", team_id: "T_FIXTURE" });
  const partial = slackWith({ ok: true, user_id: "U_FIXTURE" });
  // When boot runs with each; then the full one authenticates through auth.test and the partial one fails.
  const world = newWorld();
  const good = await bootCheck({ ...bootDeps(world), slack: slackAuthCheck(ok.slack) });
  const bad = await bootCheck({ ...bootDeps(world), slack: slackAuthCheck(partial.slack) });
  expect(ok.calls).toEqual(["https://slack.test/api/auth.test"]);
  expect(good.lines).toContain("SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)");
  expect(bad.lines).toContain("SLACK auth failed");
  expect(bad.exitCode).toBe(1);
  expect(await slackAuthCheck(null)()).toBeNull();
});

test("Slack runs after the local checks and a stalled auth.test ends at the deadline", async () => {
  // Given a Slack step that records how many local calls ran before it, then never answers.
  const world = newWorld();
  let localCallsFirst = -1;
  const stalled = async () => {
    localCallsFirst = world.calls.length;
    return await new Promise<never>(() => {});
  };
  // When boot runs with a short deadline.
  const result = await bootCheck({ ...bootDeps(world, stalled), slackDeadlineMs: 20 });
  // Then the pane list ran first, the stall is reported as a timeout, and the run is incomplete.
  expect(localCallsFirst).toBe(1);
  expect(result.lines).toContain("SLACK auth.test timed out after 20 ms");
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("a corrupt journal is reported for its lane and does not stop the check", async () => {
  // Given a lane whose journal ends in a partial write.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("broken"));
  deps.reports.report("broken", "milestone", "started", T0);
  writeFileSync(deps.reports.path("broken"), `${readFileSync(deps.reports.path("broken"), "utf8")}{partial\n`);
  // When boot runs; then the lane is named with the error kind and no local path, the rest still runs, and the exit is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("JOURNAL-ERROR broken kind=invalid-journal");
  expect(result.lines.join("\n")).not.toContain(state.dir);
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

test("a launched lane with no journal at all reads NO-REPORT, never nothing", async () => {
  // Given a launched lane that has not written reports.jsonl yet.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("silent"));
  // When boot runs; then the lane is listed as having no journal, and that alone is not a failure.
  const result = await bootCheck(deps);
  expect(result.lines).toContain("NO-REPORT silent registryStatus=working (no journal)");
  expect(result.exitCode).toBe(0);
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
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([{ command: "dori watch adopted", monitorId: "mon_ADOPTED" }]).data));
  // When boot runs; then the journal is ignored like freshness ignores it, and the watch is kept.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => /^(NO-)?REPORT adopted/.test(l))).toBe(false);
  expect(result.lines).toContain("MONITORS cleanupCandidates=0 deliveryPaused=0 expired=0 (from metadata; liveness unverified)");
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
  expect(result.lines).toContain("JOURNAL-ERROR a-broken kind=EISDIR");
  expect(result.lines.join("\n")).not.toContain(state.dir);
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
  writeFileSync(join(good, "owner.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_GOOD" }]).data));
  // When boot runs; then both bad files are named, the good watch is still listed, and the run is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "null.json")}`);
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "string.json")}`);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});

test("expired and delivery-paused watches are listed apart from live ones, and an expired one gets no stop call", async () => {
  // Given a closed lane with a live, a delivery-paused and an expired persistent watch.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("closed", "closed"));
  const terminal = join(deps.sessionsDir, "lead", "extensions", "terminal");
  mkdirSync(terminal, { recursive: true });
  writeFileSync(join(terminal, "owner.json"), JSON.stringify(manifest([
    { command: "dori watch closed", monitorId: "mon_EXPIRED", expiresAt: T0 - 1 },
    { command: "dori watch closed", monitorId: "mon_PAUSED", expiresAt: T0 + 60_000, deliveryPaused: true },
    { command: "dori watch closed", monitorId: "mon_LIVE", expiresAt: T0 + 60_000 },
  ]).data));
  // When boot runs.
  const result = await bootCheck(deps);
  const watchLines = result.lines.filter((l) => /^(MONITORS cleanup|CLEANUP|STOP|EXPIRED)/.test(l));
  const owner = `ownerSession=owner metadata=${join(terminal, "owner.json")}`;
  // Then live comes first, the paused one is flagged, and the expired one is listed without a stop call.
  expect(watchLines).toEqual([
    "MONITORS cleanupCandidates=2 deliveryPaused=1 expired=1 (from metadata; liveness unverified)",
    `CLEANUP closed match=closed:command:key ${owner}`,
    'STOP in the owner session only: kill_bash({"bash_id":"mon_LIVE"})',
    `CLEANUP closed match=closed:command:key ${owner} deliveryPaused=true`,
    'STOP in the owner session only: kill_bash({"bash_id":"mon_PAUSED"})',
    `EXPIRED closed match=closed:command:key ${owner} expiresAt=${new Date(T0 - 1).toISOString()}; nothing to stop`,
  ]);
});

test("dori boot reads the current session's terminal metadata from PI_SESSION_DIR and PI_SESSION_FILE", async () => {
  // Given a closed lane and one watch on it in each of the two env-named session directories, outside sessionsDir.
  const home = join(state.dir, "home");
  const stateDir = join(state.dir, "state");
  const current = join(state.dir, "current", "extensions", "terminal");
  const fileDir = join(state.dir, "other", "extensions", "terminal");
  for (const dir of [home, current, fileDir]) mkdirSync(dir, { recursive: true });
  await new Registry(stateDir).write(lane("closed", "closed"));
  writeFileSync(join(current, "a.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_SESSIONDIR" }]).data));
  writeFileSync(join(fileDir, "b.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_SESSIONFILE" }]).data));
  // When the real CLI runs boot with no Slack token and no herdr on PATH.
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "boot"], {
    env: {
      HOME: home, PATH: dirname(process.execPath), TMPDIR: state.dir, DORI_TELEMETRY: "0",
      DORI_CONFIG: join(home, "none.json"), DORI_STATE_DIR: stateDir, DORI_LEAD_PANE: "w9:p1",
      PI_SESSION_DIR: join(state.dir, "current"), PI_SESSION_FILE: join(state.dir, "other", "session.jsonl"),
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  // Then both directories were read, Slack was skipped, and the missing pane list makes the run incomplete.
  expect(out).toContain(`CLEANUP closed match=closed:command:key ownerSession=owner metadata=${join(current, "a.json")}`);
  expect(out).toContain(`CLEANUP closed match=closed:command:key ownerSession=owner metadata=${join(fileDir, "b.json")}`);
  expect(out).toContain("SLACK skipped (DORI_SLACK_TOKEN not set)");
  expect(out).toContain("PANES unavailable (herdr pane list failed)");
  expect(code).toBe(1);
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
  writeFileSync(join(good, "owner.json"), JSON.stringify(manifest([{ command: "dori watch closed", monitorId: "mon_GOOD" }]).data));
  // When boot runs.
  const result = await bootCheck(deps);
  // Then the bad file is named, the good one still yields its stop call, and its path is shell-quoted.
  expect(result.lines).toContain(`MONITORS unreadable ${join(bad, "owner.json")}`);
  expect(result.lines).toContain(`CLEANUP closed match=closed:command:key ownerSession=owner metadata='${join(good, "owner.json")}'`);
  expect(result.lines).toContain('STOP in the owner session only: kill_bash({"bash_id":"mon_GOOD"})');
  expect(result.exitCode).toBe(1);
});
