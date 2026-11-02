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
    expect(new Lessons(state.dir).list().map(({ rule, evidence, lane, cwd, outcome }) => ({ rule, evidence, lane, cwd, outcome })))
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
    expect(new Lessons(state.dir).list()).toEqual([]);
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
    expect((await deps.registry.read(lane.key))?.status ?? "working").toBe("working");
  } finally { state.done(); }
});
