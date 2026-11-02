import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Lessons } from "../src/lessons.ts";
import { Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const T0 = Date.parse("2026-10-29T00:00:00Z");

test("CLI add/list/mark survives separate processes and rejects invalid outcomes", async () => {
  // Given a registered closed lane: lessons can be recorded after close too.
  const state = withState();
  try {
    const config = join(state.dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
    await new Registry(state.dir).write({
      key: "qa-lessons", title: "QA", thread: "none", brief: "/brief.md", done: "/done.md",
      cwd: state.dir, openedAt: new Date(T0).toISOString(), closedAt: new Date(T0).toISOString(),
    });
    const invoke = (...args: string[]) => run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
    // When separate CLI invocations add and mark a persisted record.
    const added = await invoke("lesson", "add", "qa-lessons", "--rule", "Use event subscriptions", "--evidence", "/tmp/evidence");
    expect(added.code).toBe(0);
    const stored = new Lessons(state.dir).list()[0];
    if (!stored) throw new Error("CLI did not persist the lesson");
    expect(JSON.parse(added.out)).toEqual(stored);
    const marked = await invoke("lesson", "mark", stored.id, "--outcome", "helped");
    // Then returned JSON, reloaded JSONL and filtered CLI listing agree.
    expect(marked.code).toBe(0);
    const listed = await invoke("lesson", "list", "--cwd", state.dir);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.out)).toEqual([{ ...stored, outcome: "helped" }]);
    const before = readFileSync(new Lessons(state.dir).path, "utf8");
    expect((await invoke("lesson", "mark", stored.id, "--outcome", "typo")).code).toBe(1);
    expect((await invoke("lesson", "add", "qa-lessons", "--evidence", "/tmp/evidence")).code).toBe(1);
    expect(readFileSync(new Lessons(state.dir).path, "utf8")).toBe(before);
  } finally { state.done(); }
});
