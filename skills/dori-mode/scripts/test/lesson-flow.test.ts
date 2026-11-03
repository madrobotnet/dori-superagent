import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { closeLane } from "../src/done-flow.ts";
import { launchLane, prepareLaunch } from "../src/launch.ts";
import { Lessons } from "../src/lessons.ts";
import type { Lane } from "../src/registry.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-10-29T00:00:00Z");
const lane: Lane = { key: "lesson-flow", title: "QA", thread: "none", brief: "/b.md", done: "merged acme/app#1", cwd: "/repo", openedAt: new Date(T0).toISOString() };
const lesson = { rule: "Subscribe before triggering", evidence: "/evidence/test.txt" };

test("successful close records a pending lesson with the lane's repo", async () => {
  // Given live completion signals.
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
    // When an optional lesson accompanies close.
    const result = await closeLane(deps, lane, "verified", lesson);
    // Then both close and lesson persist.
    expect(result.closed).toBe(true);
    expect((await deps.registry.read(lane.key))?.status).toBe("closed");
    expect(new Lessons(state.dir).read().lessons.map(({ rule, evidence, lane, cwd, outcome }) => ({ rule, evidence, lane, cwd, outcome })))
      .toEqual([{ ...lesson, lane: lane.key, cwd: "/repo", outcome: "pending" }]);
  } finally { state.done(); }
});

test("failed completion gates cannot add a lesson or close a lane", async () => {
  // Given a completion signal that is not live.
  const state = withState();
  try {
    const world = newWorld();
    world.prState = "OPEN";
    const deps = depsFor(world, fakeClock(T0), state.dir);
    // When close includes a lesson.
    const result = await closeLane(deps, lane, "not ready", lesson);
    // Then neither operation is performed.
    expect(result.closed).toBe(false);
    expect(new Lessons(state.dir).read().lessons).toEqual([]);
    expect(await deps.registry.read(lane.key)).toBeNull();
  } finally { state.done(); }
});

test("lesson storage failure warns but does not block a valid close", async () => {
  // Given an unusable lesson path and otherwise working registry.
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
    mkdirSync(join(state.dir, "lessons.jsonl"));
    // When the optional write fails.
    const result = await closeLane(deps, lane, "verified", lesson);
    // Then closed state survives and the failure has an explicit receipt.
    expect(result.closed).toBe(true);
    expect((await deps.registry.read(lane.key))?.status).toBe("closed");
    expect(result.lines.some((line) => line.startsWith("LESSON_WARNING "))).toBe(true);
  } finally { state.done(); }
});

test("omitting a lesson leaves the existing close path independent of the journal", async () => {
  // Given a malformed optional journal.
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
    writeFileSync(join(state.dir, "lessons.jsonl"), "invalid\n");
    // When no lesson is requested.
    const result = await closeLane(deps, lane, "verified");
    // Then close succeeds without touching the journal.
    expect(result.closed).toBe(true);
    expect(readFileSync(join(state.dir, "lessons.jsonl"), "utf8")).toBe("invalid\n");
  } finally { state.done(); }
});

test("preview is side-effect free and actual launch ships the same prepared brief", async () => {
  // Given a real brief, lessons and a fake external pane creator.
  const state = withState();
  try {
    const world = newWorld(), clock = fakeClock(T0);
    const deps = depsFor(world, clock, state.dir);
    const brief = join(state.dir, "brief.md"), original = "Perform the fixture work.";
    writeFileSync(brief, original);
    new Lessons(state.dir).add({ ...lesson, lane: lane.key, cwd: "/repo" }, T0);
    const input = { key: lane.key, title: lane.title, brief, done: lane.done };
    // When preparing without execution.
    const preview = await prepareLaunch(deps, input);
    // Then there is no file, registry or external effect.
    expect(readFileSync(brief, "utf8")).toBe(original);
    expect(await deps.registry.list()).toEqual([]);
    expect(world.calls).toEqual([]);
    // When actually launching through the same preparation path.
    const launched = await launchLane({ ...deps, run: async (argv, opts) =>
      argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
        ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "qa:p1" }, tab_id: "qa:t1" } }), err: "" }
        : deps.run(argv, opts),
    }, input);
    // Then byte-for-byte shipped-copy equality protects preview/launch parity.
    expect(readFileSync(brief, "utf8")).toBe(preview.preamble);
    expect(launched.lane.pane).toBe("qa:p1");
    expect(await deps.registry.read(lane.key)).toMatchObject({ key: lane.key, pane: "qa:p1", tab: "qa:t1" });
  } finally { state.done(); }
});

test("a retry after a failed tab create ships the same brief, not a second lessons block and footer", async () => {
  // Given a brief, a lesson, and a herdr whose first tab create fails.
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir);
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "Perform the fixture work.");
    new Lessons(state.dir).add({ ...lesson, lane: lane.key, cwd: "/repo" }, T0);
    const input = { key: lane.key, title: lane.title, brief, done: lane.done, cwd: "/repo" };
    const expected = (await prepareLaunch(deps, input)).preamble;
    let creates = 0;
    const run: typeof deps.run = async (argv, opts) =>
      argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
        ? ++creates === 1
          ? { code: 1, out: "", err: "server busy" }
          : { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "qa:p1" }, tab_id: "qa:t1" } }), err: "" }
        : deps.run(argv, opts);
    // When the first launch fails and the lead runs it again.
    await expect(launchLane({ ...deps, run }, input)).rejects.toThrow("herdr tab create failed");
    await launchLane({ ...deps, run }, input);
    // Then the shipped brief is the one a first launch would have shipped.
    expect(readFileSync(brief, "utf8")).toBe(expected);
  } finally { state.done(); }
});

test("a brief that quotes the footer heading mid-file is shipped whole on first launch and on retry", async () => {
  // Given a copied launched brief with new work below its old footer, a lesson, and a herdr whose first tab create fails.
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
    const brief = join(state.dir, "brief.md");
    const original = "Perform the fixture work.\n\n## Lane footer (written by dori launch)\n- Key: old-lane. Work thread: none.\n\nThen do the new work below the old footer.";
    writeFileSync(brief, original);
    new Lessons(state.dir).add({ ...lesson, lane: lane.key, cwd: "/repo" }, T0);
    const input = { key: lane.key, title: lane.title, brief, done: lane.done, cwd: "/repo" };
    // When the first launch is prepared.
    const first = (await prepareLaunch(deps, input)).preamble;
    // Then the whole owner text is in it.
    expect(first).toContain(original);
    let creates = 0;
    const run: typeof deps.run = async (argv, opts) =>
      argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
        ? ++creates === 1
          ? { code: 1, out: "", err: "server busy" }
          : { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "qa:p1" }, tab_id: "qa:t1" } }), err: "" }
        : deps.run(argv, opts);
    // When that launch fails and the lead runs it again.
    await expect(launchLane({ ...deps, run }, input)).rejects.toThrow("herdr tab create failed");
    await launchLane({ ...deps, run }, input);
    // Then the retry ships the first launch's brief: the owner text whole, one lessons block and one dori footer.
    const shipped = readFileSync(brief, "utf8");
    expect(shipped).toBe(first);
    expect(shipped.split("## Lessons for this repo").length - 1).toBe(1);
    expect(shipped.split(`- Key: ${lane.key}.`).length - 1).toBe(1);
  } finally { state.done(); }
});

test("a damaged journal line does not stop a launch; the brief keeps the valid lessons and names the line", async () => {
  // Given a valid lesson for the repo and a damaged line after it.
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(T0), state.dir);
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "Perform the fixture work.");
    const journal = new Lessons(state.dir);
    journal.add({ ...lesson, lane: lane.key, cwd: "/repo" }, T0);
    writeFileSync(journal.path, `${readFileSync(journal.path, "utf8")}not-json\n`);
    // When preparing the launch.
    const prepared = await prepareLaunch(deps, { key: lane.key, title: lane.title, brief, done: lane.done, cwd: "/repo" });
    // Then the lesson still reaches the brief and the bad line is a warning, not an abort.
    expect(prepared.preamble).toContain(`] ${lesson.rule}`);
    expect(prepared.warnings).toEqual([expect.stringContaining(`${journal.path}:2: `)]);
  } finally { state.done(); }
});
