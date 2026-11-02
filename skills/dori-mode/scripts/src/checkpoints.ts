import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmdirSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { LANE_KEY } from "./registry.ts";

export type CheckpointInput = {
  readonly step: string;
  readonly result: string;
  readonly evidence: readonly string[];
  readonly remoteEffects: readonly string[];
};
export type Checkpoint = CheckpointInput & { readonly key: string; readonly at: string };
export class CheckpointError extends Error {}

const validate = (input: CheckpointInput): void => {
  if (typeof input.step !== "string" || !input.step.trim() ||
      typeof input.result !== "string" || !input.result.trim() ||
      !Array.isArray(input.evidence) || !input.evidence.every((v) => typeof v === "string") ||
      !Array.isArray(input.remoteEffects) || !input.remoteEffects.every((v) => typeof v === "string")) {
    throw new CheckpointError("checkpoint requires step, result, evidence[], and completed remoteEffects[]");
  }
};
const payload = (value: CheckpointInput): string => JSON.stringify({
  step: value.step, result: value.result, evidence: value.evidence, remoteEffects: value.remoteEffects,
});

export class Checkpoints {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new CheckpointError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "checkpoints.jsonl");
  }

  read(key: string): Checkpoint[] {
    const path = this.path(key);
    if (!existsSync(path)) return [];
    const steps = new Set<string>();
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
      try {
        const value = JSON.parse(line) as Checkpoint;
        validate(value);
        if (value.key !== key || !Number.isFinite(Date.parse(value.at)) || steps.has(value.step)) {
          throw new CheckpointError("invalid key, timestamp, or duplicate step");
        }
        steps.add(value.step);
        return value;
      } catch (error) {
        throw new CheckpointError(`${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  write(key: string, input: CheckpointInput, now: number): { checkpoint: Checkpoint; unchanged: boolean } {
    validate(input);
    const path = this.path(key);
    const at = new Date(now).toISOString();
    mkdirSync(dirname(path), { recursive: true });
    // Fail closed on concurrent writers or a lock left by a crashed writer.
    // Never replay a remote effect just because the process restarted.
    const lock = `${path}.lock`;
    try {
      mkdirSync(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CheckpointError(`checkpoint writer locked: ${key}`);
      throw error;
    }
    try {
      const previous = this.read(key).find((entry) => entry.step === input.step);
      if (previous) {
        if (payload(previous) !== payload(input)) throw new CheckpointError(`conflicting checkpoint step: ${input.step}`);
        return { checkpoint: previous, unchanged: true };
      }
      const checkpoint: Checkpoint = { key, at, ...JSON.parse(payload(input)) };
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, `${JSON.stringify(checkpoint)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return { checkpoint, unchanged: false };
    } finally {
      rmdirSync(lock);
    }
  }
}
