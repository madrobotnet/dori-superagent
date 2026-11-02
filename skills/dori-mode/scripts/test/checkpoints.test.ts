import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CheckpointError, Checkpoints, LOCK_STALE_MS, type CheckpointInput } from "../src/checkpoints.ts";
import { withState } from "./fakes.ts";

// A separate process takes the journal lock through the real code, says LOCKED, and holds it until stdin gets a line.
const holder = (dir: string) => {
  const source = join(import.meta.dir, "..", "src", "checkpoints.ts");
  const script = `import { Checkpoints } from ${JSON.stringify(source)};
    const release = new Checkpoints(${JSON.stringify(dir)}).lock("demo-lane", Date.now());
    console.log("LOCKED");
    for await (const _ of console) break;
    release();`;
  const proc = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const locked = (async () => {
    let seen = "";
    for await (const chunk of proc.stdout) {
      seen += new TextDecoder().decode(chunk);
      if (seen.includes("LOCKED")) return;
    }
    throw new Error(`holder exited before locking: ${seen}`);
  })();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("holder did not lock in 10 s")), 10_000).unref());
  return { proc, locked: Promise.race([locked, timeout]) };
};

const input: CheckpointInput = { step: "deploy", result: "completed", evidence: ["receipt:123"], remoteEffects: ["release:123"] };
const next: CheckpointInput = { ...input, step: "next", remoteEffects: ["release:456"] };

describe("checkpoints", () => {
  test("persists completion and returns identical replay unchanged after restart", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const written = journal.write("demo-lane", input, 1000);
      expect(written.unchanged).toBe(false);
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      const restarted = new Checkpoints(state.dir);
      expect(restarted.write("demo-lane", { remoteEffects: input.remoteEffects, evidence: input.evidence, result: input.result, step: input.step }, 2000))
        .toEqual({ checkpoint: written.checkpoint, unchanged: true });
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      expect(restarted.read("demo-lane")).toEqual([written.checkpoint]);
    } finally { state.done(); }
  });

  test("conflicting replay fails without overwriting or appending", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const first = journal.write("demo-lane", input, 1000);
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      expect(() => new Checkpoints(state.dir).write("demo-lane", { ...input, remoteEffects: ["release:other"] }, 2000))
        .toThrow("conflicting checkpoint step");
      expect(journal.read("demo-lane")).toEqual([first.checkpoint]);
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally { state.done(); }
  });

  test("a remote-effect receipt already recorded under one step is refused under another", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      const first = journal.write("demo-lane", input, 1000);
      expect(() => journal.write("demo-lane", { ...input, step: "deploy-again" }, 2000))
        .toThrow("remote effect release:123 already recorded by step deploy");
      expect(journal.read("demo-lane")).toEqual([first.checkpoint]);
    } finally { state.done(); }
  });

  test("a corrupt record after a blank line is reported at its physical line", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      journal.write("demo-lane", input, 1000);
      appendFileSync(journal.path("demo-lane"), "\n{not json\n");
      expect(() => journal.read("demo-lane")).toThrow(`${journal.path("demo-lane")}:3:`);
    } finally { state.done(); }
  });

  test("rejects malformed input, invalid keys, corrupt journals and duplicate stored steps", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      expect(journal.read("demo-lane")).toEqual([]);
      expect(() => journal.path("../escape")).toThrow(CheckpointError);
      expect(() => journal.write("demo-lane", { ...input, step: "" }, 1000)).toThrow(CheckpointError);
      const { checkpoint } = journal.write("demo-lane", input, 1000);
      appendFileSync(journal.path("demo-lane"), `${JSON.stringify(checkpoint)}\n`);
      expect(() => journal.read("demo-lane")).toThrow("duplicate step");
      expect(() => journal.write("demo-lane", next, 1000)).toThrow(CheckpointError);
    } finally { state.done(); }
  });

  test("a live writer in another process holds the lock; the next writer is refused, then writes once it is released", async () => {
    const state = withState();
    const { proc, locked } = holder(state.dir);
    try {
      const journal = new Checkpoints(state.dir);
      journal.write("demo-lane", input, Date.now());
      await locked;
      const before = readFileSync(journal.path("demo-lane"), "utf8");
      expect(() => journal.write("demo-lane", next, Date.now())).toThrow(`writer locked: demo-lane (pid ${proc.pid}`);
      expect(readFileSync(journal.path("demo-lane"), "utf8")).toBe(before);
      proc.stdin.write("release\n");
      await proc.stdin.end();
      expect(await proc.exited).toBe(0);
      journal.write("demo-lane", next, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally { proc.kill(); state.done(); }
  });

  test("a lock left by a writer killed mid-write is taken over at once", async () => {
    const state = withState();
    const { proc, locked } = holder(state.dir);
    try {
      const journal = new Checkpoints(state.dir);
      await locked;
      proc.kill("SIGKILL");
      await proc.exited;
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(true);
      journal.write("demo-lane", input, Date.now());
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy"]);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
    } finally { state.done(); }
  });

  test("a lock older than the bound is taken over even when its pid is alive; a younger one is refused", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      journal.lock("demo-lane", 1000); // never released: this process stays alive
      expect(() => journal.write("demo-lane", input, 1000 + LOCK_STALE_MS - 1)).toThrow("writer locked");
      journal.write("demo-lane", input, 1000 + LOCK_STALE_MS);
      expect(journal.read("demo-lane")).toHaveLength(1);
      // The lock directory an earlier build left behind has no owner record; its age decides.
      mkdirSync(`${journal.path("demo-lane")}.lock`);
      expect(() => journal.write("demo-lane", next, Date.now())).toThrow("writer locked");
      journal.write("demo-lane", next, Date.now() + LOCK_STALE_MS + 1000);
      expect(journal.read("demo-lane").map((c) => c.step)).toEqual(["deploy", "next"]);
    } finally { state.done(); }
  });
});
