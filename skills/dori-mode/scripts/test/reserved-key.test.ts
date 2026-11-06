import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { adoptLane, launchLane, LaunchError } from "../src/launch.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const REFUSED = 'lane key "lead" is reserved for the lead';
const cli = join(import.meta.dir, "../src/cli.ts");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

// Nothing written: no lanes directory, no reports journal, and only the files the test made itself.
const stateFiles = (): string[] => readdirSync(state.dir).sort();

test("launch refuses the lane key lead before it writes the brief, the registry or a tab", async () => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# brief\n");
  const deps = depsFor(world, fakeClock(T0), state.dir);
  const error = await launchLane(deps, { key: "lead", title: "t", brief, done: "closed acme/app#3" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LaunchError);
  expect((error as Error).message).toBe(REFUSED);
  expect(await deps.registry.read("lead")).toBeNull();
  expect(readFileSync(brief, "utf8")).toBe("# brief\n");
  expect(world.calls).toEqual([]);
  expect(stateFiles()).toEqual(["brief.md"]);
});

test("adopt refuses the lane key lead and registers nothing", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(adoptLane(deps, { key: "lead", title: "t", brief: "/b.md", done: "closed acme/app#3", pane: "lead:p1" })).rejects.toThrow(REFUSED);
  expect(await deps.registry.read("lead")).toBeNull();
  expect(stateFiles()).toEqual([]);
  // A key that only contains the word is an ordinary lane.
  expect((await adoptLane(deps, { key: "lead-docs", title: "t", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" })).key).toBe("lead-docs");
});

test("dori launch and dori adopt with key lead exit 1 with the reserved message and write nothing", async () => {
  const config = join(state.dir, "config.json");
  const brief = join(state.dir, "brief.md");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  writeFileSync(brief, "# brief\n");
  const invoke = (...args: string[]) => run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
  const common = ["--title", "t", "--brief", brief, "--done", "closed acme/app#3"];
  for (const args of [["launch", "lead", ...common], ["launch", "lead", ...common, "--dry-run"], ["adopt", "lead", ...common, "--pane", "lead:p1"]]) {
    const r = await invoke(...args);
    expect({ args, code: r.code, err: r.err.trim() }).toEqual({ args, code: 1, err: REFUSED });
  }
  expect(readFileSync(brief, "utf8")).toBe("# brief\n");
  expect(stateFiles()).toEqual(["brief.md", "config.json"]);
});

test("byPane never returns a record keyed lead left from before the key was reserved", async () => {
  // Given a legacy registry record named lead on the lead's pane, next to a real lane.
  const registry = new Registry(state.dir);
  const legacy = { key: "lead", title: "old", thread: "none", pane: "lead:p1", brief: "/b.md", done: "closed acme/app#3", openedAt: new Date(T0).toISOString() };
  await registry.write(legacy);
  await registry.write({ ...legacy, key: "real-lane", pane: "w:p2" });
  // Then the lead's pane resolves to no lane, the lane's pane still resolves, and the record stays readable by key.
  expect(await registry.byPane("lead:p1")).toBeNull();
  expect((await registry.byPane("w:p2"))?.key).toBe("real-lane");
  expect((await registry.read("lead"))?.pane).toBe("lead:p1");
  expect(existsSync(registry.path("lead"))).toBe(true);
});
