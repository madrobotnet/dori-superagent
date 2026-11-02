import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";

import { freshnessTick } from "../src/freshness.ts";
import { parseEvent, ReportError, Reports, reportLine } from "../src/reports.ts";
import { statusOf, type Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const lane: Lane = {
  key: "report-lane", title: "reports", thread: "chat:team/1", pane: "w:p7",
  brief: "/b.md", done: "file /done.md", openedAt: new Date(T0).toISOString(),
  reportProtocol: "jsonl-v1",
};
let state: ReturnType<typeof withState>;
let reports: Reports;
beforeEach(() => {
  state = withState();
  reports = new Reports(state.dir);
});
afterEach(() => state.done());

test("report transitions survive restarting the reader without changing done protocol", async () => {
  // Given an open lane with an independent completion status.
  const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
  await deps.registry.write(lane);
  // When each report kind is appended in order.
  for (const [kind, expected] of [
    ["milestone", "running"], ["blocker", "blocked"], ["milestone", "running"],
    ["halted", "halted"], ["milestone", "running"], ["done", "done"],
  ] as const) {
    reports.report(lane.key, kind, `state ${expected}`, T0);
    // Then fresh readers recover the persisted state, not a memory cache.
    expect(new Reports(state.dir).read(lane.key)?.state).toBe(expected);
  }
  expect(statusOf((await deps.registry.read(lane.key)) ?? lane)).toBe("working");
  expect(readFileSync(reports.path(lane.key), "utf8").trim().split("\n")).toHaveLength(6);
});

test("report text round trips quotes and newlines but prints one human line", () => {
  // Given untrusted text that must remain data.
  const text = 'tests passed\npush "abc123"; $(not a command)';
  // When recorded and rendered.
  const report = reports.report(lane.key, "milestone", text, T0);
  // Then JSON preserves text while terminal output stays a single line.
  expect(new Reports(state.dir).read(lane.key)?.lastReport?.text).toBe(text);
  expect(reportLine(report)).toBe(`[REPORT] ${lane.key} | milestone | tests passed push "abc123"; $(not a command)`);
});

test("the printed line carries no terminal controls, while the journal keeps the raw text", () => {
  // Given text with a carriage return, a CSI erase, an OSC title and a bell.
  const text = "tests passed\r\u001b[2Kall green\u001b]0;owned\u0007 done\u0008";
  // When recorded and rendered.
  const report = reports.report(lane.key, "milestone", text, T0);
  // Then only printable text reaches the terminal, and the record is unchanged.
  expect(reportLine(report)).toBe(`[REPORT] ${lane.key} | milestone | tests passed all green done`);
  expect(new Reports(state.dir).read(lane.key)?.lastReport?.text).toBe(text);
});

test.each(["../escape", "/root", "x", "bad key"])("rejects invalid lane path %s", (key) => {
  // Given an unsafe key; when selecting storage; then no path is accepted.
  expect(() => reports.path(key)).toThrow(ReportError);
});

test.each([
  '{"type":"report","key":"other","at":"2026-01-01","kind":"done","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"bad","kind":"done","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"2026-01-01","kind":"unknown","text":"ok"}',
  '{"type":"report","key":"report-lane","at":"2026-01-01","kind":"done","text":" "}',
])("rejects malformed report records %#", (line) => {
  // Given an invalid record; when parsed; then it cannot assert progress.
  expect(() => parseEvent(line, lane.key)).toThrow(ReportError);
});

test("a corrupt journal fails with its line number instead of hiding a lost report", () => {
  // Given a valid report followed by corruption.
  reports.report(lane.key, "milestone", "first", T0);
  appendFileSync(reports.path(lane.key), "{partial\n");
  // When the journal is read; then corruption is explicit.
  expect(() => reports.read(lane.key)).toThrow("reports.jsonl:2:");
});

test("one corrupt journal is reported once and does not stop the sweep for other lanes", async () => {
  // Given a lane with a corrupt journal and another lane that is silent past the nudge time.
  const world = newWorld();
  world.screen = "Working (1m)\n❯ ";
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write({ ...lane, key: "bad-lane", pane: "w:p8" });
  await deps.registry.write(lane);
  reports.report("bad-lane", "milestone", "first", T0);
  appendFileSync(reports.path("bad-lane"), "{partial\n");
  reports.report(lane.key, "milestone", "started", T0);
  // When freshness runs twice.
  const first = await freshnessTick(deps, "/home/test");
  // Then the healthy lane is still nudged, and the error is printed once with its line number.
  expect(first.map((act) => `${act.kind} ${act.lane}`).sort()).toEqual(["journal-error bad-lane", `nudged ${lane.key}`]);
  expect(first.find((act) => act.kind === "journal-error")?.detail).toContain("reports.jsonl:2:");
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual([]);
});

test("compaction failure stalls immediately and Working resumes progress", () => {
  // Given a fresh running lane.
  reports.report(lane.key, "milestone", "started", T0);
  // When compaction fails and subsequently real activity resumes.
  expect(reports.observe(lane.key, "Error: compaction failed\n❯ ", T0 + MIN, 15 * MIN)?.state).toBe("stalled");
  expect(reports.observe(lane.key, "Working (2s)\n❯ ", T0 + 2 * MIN, 15 * MIN)?.state).toBe("running");
  // Then the last report still supplies the report clock.
  expect(reports.read(lane.key)?.lastReport?.at).toBe(new Date(T0).toISOString());
});

test("a compaction error left above a later Working line does not keep the lane stalled", () => {
  // Given a lane that stalled on a compaction failure.
  reports.report(lane.key, "milestone", "started", T0);
  expect(reports.observe(lane.key, "Error: compaction failed\n❯ ", T0 + MIN, 15 * MIN)?.state).toBe("stalled");
  // When it recovers while the old error is still on screen; then Working below it wins.
  expect(reports.observe(lane.key, "Error: compaction failed\n❯ retry\nWorking (3s)\n❯ ", T0 + 2 * MIN, 15 * MIN)?.state).toBe("running");
  // And a new failure below the Working line stalls it again.
  expect(reports.observe(lane.key, "Working (3s)\nauto-compaction failed\n❯ ", T0 + 3 * MIN, 15 * MIN)?.state).toBe("stalled");
});

test("only a stale idle prompt stalls and repeated observations do not grow the log", () => {
  // Given a milestone with a fresh prompt.
  reports.report(lane.key, "milestone", "started", T0);
  expect(reports.observe(lane.key, "❯ ", T0 + MIN, 15 * MIN)?.state).toBe("running");
  // When the same prompt outlives the freshness threshold.
  expect(reports.observe(lane.key, "❯ ", T0 + 16 * MIN, 15 * MIN)?.state).toBe("stalled");
  reports.observe(lane.key, "❯ ", T0 + 17 * MIN, 15 * MIN);
  // Then one state transition, rather than every poll, is persisted.
  expect(readFileSync(reports.path(lane.key), "utf8").trim().split("\n")).toHaveLength(2);
});

test.each(["blocker", "halted", "done"] as const)("pane activity cannot overwrite a declared %s state", (kind) => {
  // Given explicit lane intent.
  reports.report(lane.key, kind, "paused", T0);
  const expected = reports.read(lane.key)?.state;
  // When the pane still shows Working or a compaction failure.
  reports.observe(lane.key, "Working (25m)\ncompaction failed\n❯ ", T0 + 30 * MIN, 15 * MIN);
  // Then intent takes precedence over stale screen content.
  expect(new Reports(state.dir).read(lane.key)?.state).toBe(expected);
});

test("freshness forwards a durable report after it has scrolled off the pane", async () => {
  // Given a stale report, but an actively working pane with no report text.
  const world = newWorld();
  world.screen = "Working (2m)\n❯ ";
  const deps = depsFor(world, fakeClock(T0 + 21 * MIN), state.dir, {
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  await deps.registry.write({ ...lane, lastNudgeAt: T0 + 20 * MIN });
  reports.report(lane.key, "milestone", "all checks green", T0);
  // When freshness reads its authoritative journal.
  const acts = await freshnessTick(deps, "/home/test");
  // Then forwarding uses the report, never NO-REPORT.
  expect(acts.map((act) => act.kind)).toEqual(["posted"]);
  expect(world.calls.find((call) => call[0] === "notify")?.[2]).toContain("all checks green");
});

test("new report time suppresses nudges even when registry lastReplyAt is old", async () => {
  // Given a newly reported milestone and an old registry timestamp.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  await deps.registry.write(lane);
  reports.report(lane.key, "milestone", "just completed step", T0 + 29 * MIN);
  // When freshness runs; then no stale-registry nudge is sent.
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(world.calls.some((call) => call[2] === "send-text")).toBe(false);
});

test("a stalled structured lane alerts once even without a thread hook", async () => {
  // Given a lane whose idle prompt has no fresh progress.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 21 * MIN), state.dir);
  await deps.registry.write({ ...lane, thread: "none" });
  reports.report(lane.key, "milestone", "started", T0);
  // When observed twice; then one alert is emitted and no input is injected.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["stalled"]);
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  expect(world.calls.some((call) => call[2] === "send-text")).toBe(false);
});

test.each(["blocker", "halted", "done"] as const)("a %s report still reaches the thread, but the lane is not nudged", async (kind) => {
  // Given a lane that declared %s and then stayed silent past both thresholds.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  await deps.registry.write(lane);
  reports.report(lane.key, kind, "needs the owner", T0);
  // When freshness runs; then the report is posted and nothing is sent to the pane.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
  expect(world.calls.find((call) => call[0] === "notify")?.[2]).toContain("needs the owner");
  expect(world.calls.some((call) => call[2] === "send-text")).toBe(false);
});

test("a lane that reports every 10 minutes still gets its latest report posted, at most once per postAfterMin", async () => {
  // Given a lane whose reports keep the nudge clock fresh while its thread stays quiet.
  const world = newWorld();
  const clock = fakeClock(T0 + 21 * MIN);
  const deps = depsFor(world, clock, state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
  await deps.registry.write(lane);
  world.screen = "Working (1m)\n❯ ";
  reports.report(lane.key, "milestone", "step one", T0 + 5 * MIN);
  reports.report(lane.key, "milestone", "step two", T0 + 15 * MIN);
  const posts = () => world.calls.filter((call) => call[0] === "notify").map((call) => call[2]);
  // When freshness runs 21 minutes after launch; then the latest report is posted.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
  expect(posts().at(-1)).toContain("step two");
  // And a newer report waits until the thread has been quiet for postAfterMin again.
  reports.report(lane.key, "milestone", "step three", T0 + 30 * MIN);
  clock.at = T0 + 31 * MIN;
  expect(await freshnessTick(deps, "/home/test")).toEqual([]);
  clock.at = T0 + 41 * MIN;
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["posted"]);
  expect(posts()).toHaveLength(2);
  expect(posts().at(-1)).toContain("step three");
});

test("an adopted lane ignores a journal record and keeps the screen path", async () => {
  // Given an adopted lane (no reportProtocol) with a blocker record and 30 silent minutes.
  const world = newWorld();
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir);
  const { reportProtocol: _, ...adopted } = lane;
  await deps.registry.write(adopted);
  reports.report(lane.key, "blocker", "waiting on review", T0);
  // When freshness runs; then the journal does not hold back the nudge.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["nudged"]);
});

test("structured lanes never fall back to unrelated pane report text", async () => {
  // Given a new-protocol lane with no journal and report-like screen output.
  const world = newWorld();
  world.screen = `[REPORT] ${lane.key} | done | example, not durable`;
  const deps = depsFor(world, fakeClock(T0 + 30 * MIN), state.dir, {
    hooks: { threadReply: ["notify", "{thread}", "{text}"] },
  });
  await deps.registry.write({ ...lane, lastNudgeAt: T0 + 29 * MIN });
  // When forwarding is due; then the missing journal remains explicit.
  expect((await freshnessTick(deps, "/home/test")).map((act) => act.kind)).toEqual(["no-report"]);
  expect(world.calls.some((call) => call[0] === "notify")).toBe(false);
});
