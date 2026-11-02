import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { closeLane } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { launchLane } from "../src/launch.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const MIN = 60_000;
const lane: Lane = {
  key: "hardening-qa", title: "QA", thread: "none", pane: "qa:p1",
  brief: "/b.md", done: "merged acme/app#1", openedAt: new Date(T0).toISOString(), reportProtocol: "jsonl-v1",
};

test("freshness keeps a hung timer stalled without duplicate transitions or alerts", async () => {
  // Given the full freshness path and a running timer.
  const state = withState();
  try {
    const world = newWorld(), clock = fakeClock(T0);
    const deps = depsFor(world, clock, state.dir, { nudgeAfterMin: 999, supervision: { gitActivity: false } });
    await deps.registry.write(lane);
    const reports = new Reports(state.dir);
    reports.report(lane.key, "milestone", "started", T0);
    world.screen = "Working (21m 0s)\n❯ ";
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    // When the same timer grows beyond the no-activity threshold.
    clock.at += 20 * MIN;
    world.screen = "Working (41m 0s)\n❯ ";
    expect((await freshnessTick(deps, "/home/test")).map((a) => a.kind)).toEqual(["stalled"]);
    const captured = readFileSync(reports.path(lane.key), "utf8");
    clock.at += MIN;
    world.screen = "Working (42m 0s)\n❯ ";
    // Then the legacy Working observer cannot undo the stall every sweep.
    expect(await freshnessTick(deps, "/home/test")).toEqual([]);
    expect(readFileSync(reports.path(lane.key), "utf8")).toBe(captured);
    expect(reports.read(lane.key)?.state).toBe("stalled");
    expect(world.calls.some((c) => c.includes("close") || c.includes("send-text"))).toBe(false);
  } finally { state.done(); }
});

test("freshness persists a wall ceiling blocker without sending or terminating", async () => {
  // Given a new lane at its configured ceiling.
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0 + MIN), state.dir, { supervision: { defaults: { wallMinutes: 1 }, gitActivity: false } });
    await deps.registry.write(lane);
    new Reports(state.dir).report(lane.key, "milestone", "started", T0);
    // When the regular freshness command runs its supervision step.
    const result = await freshnessTick(deps, "/home/test");
    // Then state and alert agree, and only a pane read was needed.
    expect(result.map((a) => a.kind)).toEqual(["blocked"]);
    expect(new Reports(state.dir).read(lane.key)?.state).toBe("blocked");
    expect(world.calls.every((c) => c[0] === "herdr" && c[2] === "read")).toBe(true);
  } finally { state.done(); }
});

test("Runner preserves leading status columns and NUL delimiters when requested", async () => {
  // Given git-like machine output; when passed through the actual runner.
  const result = await run([process.execPath, "-e", 'process.stdout.write(" M source.ts\\u0000")'], { preserveOutput: true });
  // Then activity parsers receive the first filename without truncation.
  expect(result.code).toBe(0);
  expect(result.out).toBe(" M source.ts\0");
});

test("launch persists default and per-lane ceilings with explicit override precedence", async () => {
  // Given a real brief and a fake external pane creator.
  const state = withState();
  try {
    const brief = join(state.dir, "brief.md");
    writeFileSync(brief, "Do the fixture work.");
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir, {
      supervision: { defaults: { wallMinutes: 240, tokens: 1000, costUsd: null }, lanes: { "hardening-qa": { tokens: 2000 } } },
    });
    const original = deps.run;
    const result = await launchLane({ ...deps, run: async (argv, opts) =>
      argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
        ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "qa:p1" }, tab_id: "qa:t1" } }), err: "" }
        : original(argv, opts),
    }, { key: lane.key, title: "QA", brief, done: "merged acme/app#1", budget: { wallMinutes: null }, activityPaths: ["src/file.ts"] });
    // Then launched registry data, not prompt prose, pins the configured behavior.
    expect(result.lane.budget).toEqual({ wallMinutes: null, tokens: 2000, costUsd: null });
    expect((await deps.registry.read(lane.key))?.activityPaths).toEqual(["src/file.ts"]);
    expect(new Reports(state.dir).read(lane.key)?.state).toBe("running");
  } finally { state.done(); }
});

test("config rejects invalid ceilings and retains defaults when only one is overridden", async () => {
  // Given a concrete configuration boundary.
  const state = withState();
  try {
    const path = join(state.dir, "config.json");
    writeFileSync(path, JSON.stringify({ supervision: { defaults: { tokens: 4000 } } }));
    // When loaded, default wall time and unknown cost remain explicit.
    expect((await loadConfig(path)).supervision.defaults).toEqual({ wallMinutes: 240, tokens: 4000, costUsd: null });
    writeFileSync(path, JSON.stringify({ supervision: { defaults: { tokens: -1 } } }));
    // Then a typo cannot silently disable the budget.
    await expect(loadConfig(path)).rejects.toThrow("invalid supervision tokens");
  } finally { state.done(); }
});

test("authorized close records known cost and keeps it in the lane journal", async () => {
  // Given live done signals and a configured read-only usage source.
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(T0), state.dir, {
      supervision: { usageArgv: ["usage", "{key}"], recordCostArgv: ["record-cost", "{key}", "{tokens}", "{costUsd}"] },
    });
    const external = deps.run;
    const calls: (readonly string[])[] = [];
    const result = await closeLane({ ...deps, run: async (argv, opts) => {
      calls.push(argv);
      if (argv[0] === "usage") return { code: 0, out: '{"tokens":1200,"costUsd":0.5}', err: "" };
      if (argv[0] === "record-cost") return { code: 0, out: "recorded", err: "" };
      return external(argv, opts);
    } }, lane, "verified");
    // Then the close surface reports the same cumulative values it persisted.
    expect(result.closed).toBe(true);
    expect(result.lines).toContain(`COST ${lane.key} tokens=1200 costUsd=0.5`);
    const cost = JSON.parse(readFileSync(join(state.dir, "lanes", lane.key, "cost.jsonl"), "utf8"));
    expect({ tokens: cost.tokens, costUsd: cost.costUsd }).toEqual({ tokens: 1200, costUsd: 0.5 });
    expect(calls).toContainEqual(["record-cost", lane.key, "1200", "0.5"]);
    expect((await deps.registry.read(lane.key))?.status).toBe("closed");
  } finally { state.done(); }
});
