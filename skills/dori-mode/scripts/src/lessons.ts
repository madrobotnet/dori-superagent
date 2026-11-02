import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { LANE_KEY } from "./registry.ts";

export type LessonOutcome = "pending" | "helped" | "no-effect" | "harmful" | "encoded";
export type Lesson = {
  readonly id: string;
  readonly at: string;
  readonly lane: string;
  readonly cwd: string;
  readonly rule: string;
  readonly evidence: string;
  readonly outcome: LessonOutcome;
};
export type LessonInput = Pick<Lesson, "lane" | "cwd" | "rule" | "evidence">;
export class LessonError extends Error {}

export const isLessonOutcome = (value: unknown): value is LessonOutcome =>
  value === "pending" || value === "helped" || value === "no-effect" || value === "harmful" || value === "encoded";

const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

const parseLesson = (value: unknown): Lesson => {
  if (typeof value !== "object" || value === null ||
      !("id" in value) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id) ||
      !("at" in value) || typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) ||
      !("lane" in value) || typeof value.lane !== "string" || !LANE_KEY.test(value.lane) ||
      !("cwd" in value) || !singleLine(value.cwd, 4096) || !isAbsolute(value.cwd) ||
      !("rule" in value) || !singleLine(value.rule, 400) ||
      !("evidence" in value) || !singleLine(value.evidence, 2000) ||
      !("outcome" in value) || !isLessonOutcome(value.outcome)) {
    throw new LessonError("lesson requires id, at, lane, absolute cwd, single-line rule (max 400), evidence and valid outcome");
  }
  return { id: value.id, at: value.at, lane: value.lane, cwd: value.cwd, rule: value.rule, evidence: value.evidence, outcome: value.outcome };
};

// Exact canonical cwd scopes lessons without running Git or matching unrelated repos.
const scope = (cwd: string): string => {
  if (!singleLine(cwd, 4096)) throw new LessonError("cwd must be a nonempty single-line path");
  const path = resolve(cwd);
  return existsSync(path) ? realpathSync(path) : path;
};

export class Lessons {
  readonly path: string;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "lessons.jsonl");
  }

  list(cwd?: string): Lesson[] {
    if (!existsSync(this.path)) return [];
    const latest = new Map<string, Lesson>();
    for (const [index, line] of readFileSync(this.path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const lesson = parseLesson(JSON.parse(line));
        const previous = latest.get(lesson.id);
        if (previous && (previous.at !== lesson.at || previous.lane !== lesson.lane ||
            previous.cwd !== lesson.cwd || previous.rule !== lesson.rule || previous.evidence !== lesson.evidence)) {
          throw new LessonError(`immutable fields changed for ${lesson.id}`);
        }
        latest.set(lesson.id, lesson);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof LessonError) {
          throw new LessonError(`${this.path}:${index + 1}: ${error.message}`);
        }
        throw error;
      }
    }
    const target = cwd === undefined ? undefined : scope(cwd);
    return [...latest.values()].reverse()
      .filter((lesson) => target === undefined || lesson.cwd === target)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  }

  add(input: LessonInput, now: number): Lesson {
    const lesson = parseLesson({ ...input, cwd: scope(input.cwd), id: randomUUID(), at: new Date(now).toISOString(), outcome: "pending" });
    // Refuse to extend a damaged journal; list/mark never silently discard history.
    this.list();
    this.append(lesson);
    return lesson;
  }

  mark(id: string, outcome: LessonOutcome): Lesson {
    if (!isLessonOutcome(outcome)) throw new LessonError("invalid lesson outcome");
    const previous = this.list().find((lesson) => lesson.id === id);
    if (!previous) throw new LessonError(`lesson not found: ${id}`);
    const updated = { ...previous, outcome };
    this.append(updated);
    return updated;
  }

  forRepo(cwd: string): Lesson[] {
    return this.list(cwd).filter((lesson) => lesson.outcome === "pending" || lesson.outcome === "helped").slice(0, 8);
  }

  private append(lesson: Lesson): void {
    mkdirSync(this.stateDir, { recursive: true });
    // One O_APPEND write per full record. Marks never rewrite or truncate history.
    appendFileSync(this.path, `${JSON.stringify(lesson)}\n`, { mode: 0o600 });
  }
}

export const renderLessons = (lessons: readonly Lesson[]): string => lessons.length
  ? `## Lessons for this repo\n${lessons.map((lesson) => `- [${lesson.outcome}; ${lesson.lane}] ${lesson.rule}`).join("\n")}\n\n`
  : "";
