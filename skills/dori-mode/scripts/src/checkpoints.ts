import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { hostname } from "node:os";
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

/** A write holds the lock for milliseconds, so a lock this old was left behind even if its pid is alive again (pid reuse). */
export const LOCK_STALE_MS = 2 * 60_000;
type LockOwner = { readonly pid: number; readonly host: string; readonly at: string; readonly nonce: string };
type LockSeen = { readonly raw: string | null; readonly ino: number; readonly mtimeMs: number };

// raw is null for the lock directory an earlier build used; null overall when there is no lock.
const inspect = (lock: string): LockSeen | null => {
  try {
    const stat = statSync(lock);
    return { raw: stat.isDirectory() ? null : readFileSync(lock, "utf8"), ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};
const ownerOf = (raw: string | null): LockOwner | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LockOwner> | null;
    return typeof v?.pid === "number" && typeof v.host === "string" && typeof v.at === "string" && typeof v.nonce === "string" ? v as LockOwner : null;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null; // a writer stopped between creating the lock and writing its record
  }
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

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

  /**
   * Take the journal's writer lock and return its release. The lock file records pid, host, time and a nonce. A live
   * writer's lock is refused. A lock whose pid is dead on this host, or that is LOCK_STALE_MS old, or that has no
   * owner record and was last changed that long ago, is taken over: so a writer killed mid-write never locks the lane.
   */
  lock(key: string, now: number): () => void {
    const path = this.path(key);
    mkdirSync(dirname(path), { recursive: true });
    const lock = `${path}.lock`;
    const record = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date(now).toISOString(), nonce: randomUUID() } satisfies LockOwner);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try {
          writeSync(fd, record);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        // A lock taken over after LOCK_STALE_MS belongs to its new owner; leave it.
        return () => { if (inspect(lock)?.raw === record) rmSync(lock, { force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const seen = inspect(lock);
      if (!seen) continue;
      const owner = ownerOf(seen.raw);
      const since = owner ? Date.parse(owner.at) : seen.mtimeMs;
      const dead = owner !== null && owner.host === hostname() && !alive(owner.pid);
      if (!dead && Number.isFinite(since) && now - since < LOCK_STALE_MS) {
        throw new CheckpointError(`checkpoint writer locked: ${key} (${owner ? `pid ${owner.pid}` : "no owner record"}, ${Math.max(0, Math.round((now - since) / 1000))} s old)`);
      }
      // Move the stale lock aside under a unique name, then check it is the one judged stale: another writer may have
      // taken it over and locked again in between. Rename keeps the inode, so the inode and record identify it.
      const moved = `${lock}.${process.pid}.${randomUUID()}.stale`;
      try {
        renameSync(lock, moved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const taken = inspect(moved);
      if (taken?.ino === seen.ino && taken.raw === seen.raw) {
        rmSync(moved, { recursive: true, force: true });
        continue;
      }
      // That was a live writer's lock: put it back without replacing a newer one.
      try {
        linkSync(moved, lock);
      } catch (error) {
        throw new CheckpointError(`checkpoint writer locked: ${key} (a live writer's lock could not be put back: ${(error as Error).message})`);
      } finally {
        rmSync(moved, { recursive: true, force: true });
      }
    }
    throw new CheckpointError(`checkpoint writer locked: ${key} (the lock changed hands while taking it over; retry)`);
  }

  write(key: string, input: CheckpointInput, now: number): { checkpoint: Checkpoint; unchanged: boolean } {
    validate(input);
    const path = this.path(key);
    const at = new Date(now).toISOString();
    // Never replay a remote effect just because the process restarted: the step check runs under the lock.
    const release = this.lock(key, now);
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
      release();
    }
  }
}
