import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Checkpoints } from "../src/checkpoints.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { Supervision, workingTimer, type SupervisionOptions } from "../src/supervision.ts";
import { fakeClock, withState } from "./fakes.ts";

const start = Date.parse("2026-10-29T00:00:00Z");
const lane: Lane = { key: "demo-lane", title: "Demo", thread: "", brief: "", done: "", openedAt: new Date(start).toISOString(), reportProtocol: "jsonl-v1" };
const fixture = (options: SupervisionOptions = {}) => {
  const state = withState();
  const clock = fakeClock(start);
  const calls: string[][] = [];
  const alerts: string[] = [];
  let usage = '{"tokens":null,"costUsd":null}';
  let dirty = "";
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    return { code: 0, out: argv[0] === "usage" ? usage : argv[0] === "git" ? dirty : "", err: "" };
  };
  const deps = { stateDir: state.dir, clock, run, alert: (_lane: Lane, message: string) => { alerts.push(message); } };
  return { ...state, clock, calls, alerts, deps, supervisor: new Supervision(deps, options), setUsage: (value: string) => { usage = value; }, setDirty: (value: string) => { dirty = value; } };
};

describe("supervision", () => {
  test("legacy lanes perform no commands or state writes", async () => {
    const f = fixture({ usageArgv: ["usage"] });
    try {
      expect((await f.supervisor.sweep({ ...lane, reportProtocol: undefined }, "Working 40m")).enabled).toBe(false);
      expect(await f.supervisor.close({ ...lane, reportProtocol: undefined })).toBeNull();
      expect(f.calls).toEqual([]);
      expect(existsSync(join(f.dir, "lanes"))).toBe(false);
    } finally { f.done(); }
  });

  test("growing same timer requires persisted observations and fresh-activity grace", async () => {
    const f = fixture();
    try {
      expect((await f.supervisor.sweep(lane, "Working (21m 0s)")).alerts).toEqual([]);
      f.clock.at += 20 * 60_000;
      const restarted = new Supervision(f.deps);
      expect((await restarted.sweep(lane, "Working (41m 0s)")).state).toBe("stalled");
      expect(f.alerts).toHaveLength(1);
      f.clock.at += 60_000;
      expect((await restarted.sweep(lane, "Working (42m 0s)")).alerts).toEqual([]);
      expect(new Reports(f.dir).read(lane.key)?.state).toBe("stalled");
      expect(f.calls.some((args) => /kill|send-text/.test(args.join(" ")))).toBe(false);
    } finally { f.done(); }
  });

  test("timer reset, frozen timer, and changed timer origin do not mark hung", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 1m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 30m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Running 31m")).alerts).toEqual([]);
    } finally { f.done(); }
  });

  test("report and checkpoint progress suppress hung detection until stale", async () => {
    const f = fixture();
    try {
      const reports = new Reports(f.dir);
      reports.report(lane.key, "milestone", "starting", f.clock.now());
      await f.supervisor.sweep({ ...lane, reportProtocol: undefined }, "Working 21m");
      f.clock.at += 20 * 60_000;
      reports.report(lane.key, "milestone", "progress", f.clock.now());
      expect((await f.supervisor.sweep(lane, "Working 41m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      new Checkpoints(f.dir).write(lane.key, { step: "build", result: "ok", evidence: [], remoteEffects: [] }, f.clock.now());
      expect((await f.supervisor.sweep(lane, "Working 61m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(lane, "Working 81m")).state).toBe("stalled");
    } finally { f.done(); }
  });

  test("explicit file and git changed-file activity suppress stalls without scanning", async () => {
    const f = fixture();
    try {
      const path = join(f.dir, "source.ts");
      writeFileSync(path, "first");
      const activeLane = { ...lane, cwd: f.dir, activityPaths: [path] };
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      f.setDirty(" M source.ts\0?? node_modules/\0");
      expect((await f.supervisor.sweep(activeLane, "Running 61m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(activeLane, "Running 81m")).state).toBe("stalled");
      f.clock.at += 60_000;
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      expect((await f.supervisor.sweep(activeLane, "Running 82m")).state).toBe("running");
      expect(f.calls.every((args) => args[0] === "git")).toBe(true);
    } finally { f.done(); }
  });

  test("budgets block without killing, support per-lane overrides and deduplicate alerts", async () => {
    const f = fixture({ usageArgv: ["usage", "{key}"], defaults: { wallMinutes: 100, tokens: 1000, costUsd: 10 }, lanes: { "demo-lane": { wallMinutes: 1, tokens: 10, costUsd: 1 } } });
    try {
      f.setUsage('{"tokens":10,"costUsd":1}');
      f.clock.at += 60_000;
      const result = await f.supervisor.sweep(lane, "Working 1m");
      expect(result.state).toBe("blocked");
      expect(result.usage).toEqual({ key: lane.key, at: new Date(f.clock.at).toISOString(), tokens: 10, costUsd: 1 });
      expect(result.alerts).toEqual(["wallMinutes ceiling reached (1)", "tokens ceiling reached (10)", "costUsd ceiling reached (1)"]);
      f.setUsage('{"tokens":11,"costUsd":2}');
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 2m")).alerts).toEqual([]);
      expect(f.calls).toEqual([["usage", lane.key], ["usage", lane.key]]);
      expect(new Reports(f.dir).read(lane.key)?.lastReport?.kind).toBe("blocker");
    } finally { f.done(); }
  });

  test("lane budgets override defaults and unknown usage stays null in persisted close snapshot", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{key}", "{tokens}", "{costUsd}"], defaults: { wallMinutes: 0, tokens: 0, costUsd: 0 } });
    try {
      f.setUsage('{"tokens":-1,"costUsd":"not-known"}');
      const result = await f.supervisor.sweep({ ...lane, budget: { wallMinutes: null } }, "Working 1m");
      expect(result.state).toBe("running");
      expect(result.usage?.tokens).toBeNull();
      expect(result.usage?.costUsd).toBeNull();
      expect(result.alerts).toHaveLength(2);
      f.setUsage("malformed");
      const snapshot = await f.supervisor.close(lane);
      expect(snapshot?.tokens).toBeNull();
      expect(f.calls.some((args) => args[0] === "record")).toBe(false);
      const stored = readFileSync(join(f.dir, "lanes", lane.key, "cost.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(stored.at(-1)).toEqual(snapshot);
    } finally { f.done(); }
  });

  test("available cumulative usage reaches the optional close recording hook", async () => {
    const f = fixture({ usageArgv: ["usage"], recordCostArgv: ["record", "{key}", "{tokens}", "{costUsd}"] });
    try {
      f.setUsage('{"tokens":1234,"costUsd":0.25}');
      const snapshot = await f.supervisor.close(lane);
      expect(snapshot?.tokens).toBe(1234);
      expect(f.calls.at(-1)).toEqual(["record", lane.key, "1234", "0.25"]);
    } finally { f.done(); }
  });

  test("terminal progress is not overwritten by budget or hung reports", async () => {
    const f = fixture({ defaults: { wallMinutes: 0 } });
    try {
      new Reports(f.dir).report(lane.key, "done", "finished", f.clock.now());
      expect((await f.supervisor.sweep(lane, "Working 30m")).state).toBe("done");
      expect(f.alerts).toEqual([]);
    } finally { f.done(); }
  });

  test("parses visible timer variants but not unrelated or absent durations", () => {
    expect(workingTimer("\x1b[32m* Working (1h 2m 3s)\x1b[0m")).toEqual({ kind: "working", seconds: 3723 });
    expect(workingTimer("Running 21:05")).toEqual({ kind: "running", seconds: 1265 });
    expect(workingTimer("Running 1:02:03")).toEqual({ kind: "running", seconds: 3723 });
    expect(workingTimer("Working ...")).toBeNull();
    expect(workingTimer("log mentions Working 20m")).toBeNull();
  });
});
