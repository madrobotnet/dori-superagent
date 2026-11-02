import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import { CheckpointError, Checkpoints, type CheckpointInput } from "../src/checkpoints.ts";
import { withState } from "./fakes.ts";

const input: CheckpointInput = { step: "deploy", result: "completed", evidence: ["receipt:123"], remoteEffects: ["release:123"] };

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
      journal.write("demo-lane", input, 1000);
      expect(() => new Checkpoints(state.dir).write("demo-lane", { ...input, remoteEffects: ["release:other"] }, 2000))
        .toThrow("conflicting checkpoint step");
      expect(journal.read("demo-lane")).toHaveLength(1);
      expect(existsSync(`${journal.path("demo-lane")}.lock`)).toBe(false);
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
      expect(() => journal.write("demo-lane", { ...input, step: "next" }, 1000)).toThrow(CheckpointError);
    } finally { state.done(); }
  });

  test("fails closed on concurrent or crash-left writer lock", () => {
    const state = withState();
    try {
      const journal = new Checkpoints(state.dir);
      journal.write("demo-lane", input, 1000);
      mkdirSync(`${journal.path("demo-lane")}.lock`);
      expect(() => journal.write("demo-lane", { ...input, step: "next" }, 2000)).toThrow("writer locked");
      expect(journal.read("demo-lane")).toHaveLength(1);
    } finally { state.done(); }
  });
});
