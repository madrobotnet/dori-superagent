import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeSync } from "node:fs";
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
export type LessonRead = { readonly lessons: Lesson[]; readonly problems: string[] };
export class LessonError extends Error {}

export const isLessonOutcome = (value: unknown): value is LessonOutcome =>
  value === "pending" || value === "helped" || value === "no-effect" || value === "harmful" || value === "encoded";

const singleLine = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

const FIELDS = ["id", "at", "lane", "cwd", "rule", "evidence", "outcome"] as const;
const fieldChecks: Record<(typeof FIELDS)[number], [(value: unknown) => boolean, string]> = {
  id: [(v) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v), "must be a UUID"],
  // Only the form toISOString writes: Date.parse also takes "0" or an RFC 2822 date, which must not reach a brief.
  at: [(v) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, "must be an ISO time as toISOString writes it"],
  lane: [(v) => typeof v === "string" && LANE_KEY.test(v), `must match ${LANE_KEY}`],
  cwd: [(v) => singleLine(v, 4096) && isAbsolute(v), "must be an absolute single-line path"],
  rule: [(v) => singleLine(v, 400), "must be one nonempty line of at most 400 characters"],
  evidence: [(v) => singleLine(v, 2000), "must be one nonempty line of at most 2000 characters"],
  outcome: [isLessonOutcome, "must be pending, helped, no-effect, harmful or encoded"],
};

const parseLesson = (value: unknown): Lesson => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new LessonError("lesson record must be a JSON object");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((name) => !(FIELDS as readonly string[]).includes(name));
  if (unknown !== undefined) throw new LessonError(`unknown lesson field "${unknown}"`);
  for (const name of FIELDS) {
    const [ok, rule] = fieldChecks[name];
    if (!ok(record[name])) throw new LessonError(`lesson field "${name}" ${rule}`);
  }
  return record as Lesson;
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

  /** Every valid lesson, newest first, and a problem line for each damaged one. One bad line never hides the rest. */
  read(cwd?: string): LessonRead {
    if (!existsSync(this.path)) return { lessons: [], problems: [] };
    const latest = new Map<string, Lesson>();
    const problems: string[] = [];
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
        if (!(error instanceof SyntaxError || error instanceof LessonError)) throw error;
        problems.push(`${this.path}:${index + 1}: ${error.message}`);
      }
    }
    const target = cwd === undefined ? undefined : scope(cwd);
    const lessons = [...latest.values()].reverse()
      .filter((lesson) => target === undefined || lesson.cwd === target)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return { lessons, problems };
  }

  add(input: LessonInput, now: number): Lesson {
    const lesson = parseLesson({ ...input, cwd: scope(input.cwd), id: randomUUID(), at: new Date(now).toISOString(), outcome: "pending" });
    this.append(lesson);
    return lesson;
  }

  mark(id: string, outcome: LessonOutcome): Lesson {
    if (!isLessonOutcome(outcome)) throw new LessonError("invalid lesson outcome");
    const previous = this.read().lessons.find((lesson) => lesson.id === id);
    if (!previous) throw new LessonError(`lesson not found: ${id}`);
    const updated = { ...previous, outcome };
    this.append(updated);
    return updated;
  }

  forRepo(cwd: string): LessonRead {
    const { lessons, problems } = this.read(cwd);
    return { lessons: lessons.filter((lesson) => lesson.outcome === "pending" || lesson.outcome === "helped").slice(0, 8), problems };
  }

  private append(lesson: Lesson): void {
    mkdirSync(this.stateDir, { recursive: true });
    // One O_APPEND write per full record. Marks never rewrite or truncate history. A writer that stopped mid-record
    // left no newline; start on a fresh line so the torn line stays one damaged line and this record stays whole.
    const fd = openSync(this.path, "a+", 0o600);
    try {
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(lesson)}\n`);
    } finally {
      closeSync(fd);
    }
  }
}

const LESSONS_HEADING = "## Lessons for this repo";

export const renderLessons = (lessons: readonly Lesson[]): string => lessons.length
  ? `${LESSONS_HEADING}\n${lessons.map((lesson) => `- [${lesson.outcome}; ${lesson.lane}] ${lesson.rule}`).join("\n")}\n\n`
  : "";

/** The text after a block renderLessons wrote at the top; any other text is returned unchanged. */
export const stripRenderedLessons = (text: string): string => text.replace(new RegExp(`^${LESSONS_HEADING}\\n(?:- [^\\n]*\\n)*\\n`), "");
