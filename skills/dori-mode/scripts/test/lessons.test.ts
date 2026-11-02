import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

import { LessonError, Lessons } from "../src/lessons.ts";
import { withState } from "./fakes.ts";

const T0 = Date.parse("2026-10-29T00:00:00Z");
let state: ReturnType<typeof withState>;
let lessons: Lessons;
const input = { lane: "demo-lane", cwd: "/repo", rule: "Subscribe before triggering", evidence: "/evidence/test.txt" };

beforeEach(() => { state = withState(); lessons = new Lessons(state.dir); });
afterEach(() => state.done());

test("add persists a pending lesson and mark appends without changing the original record", () => {
  // Given an empty journal.
  const added = lessons.add(input, T0);
  const original = readFileSync(lessons.path, "utf8");
  // When the lead marks the result.
  const updated = lessons.mark(added.id, "helped");
  // Then history and the materialized latest state both survive a reload.
  expect(readFileSync(lessons.path, "utf8").startsWith(original)).toBe(true);
  expect(readFileSync(lessons.path, "utf8").trim().split("\n")).toHaveLength(2);
  expect(new Lessons(state.dir).list()).toEqual([{ ...added, outcome: "helped" }]);
  expect(updated).toEqual({ ...added, outcome: "helped" });
});

test("repo selection keeps eight newest eligible lessons and excludes other cwd and retired outcomes", () => {
  // Given more than a preamble's budget and all supported outcomes.
  const eligible = Array.from({ length: 10 }, (_, i) => lessons.add({ ...input, rule: `Rule ${i}` }, T0 + i));
  const helped = eligible[3];
  if (!helped) throw new Error("fixture missing");
  lessons.mark(helped.id, "helped");
  for (const outcome of ["harmful", "no-effect", "encoded"] as const) {
    lessons.mark(lessons.add(input, T0 + 100).id, outcome);
  }
  lessons.add({ ...input, cwd: "/other-repo" }, T0 + 1000);
  // When selecting for a lexically equivalent path.
  const selected = lessons.forRepo("/repo/../repo/");
  // Then scope, filtering, ordering and cap are all observable in record IDs.
  expect(selected.map((lesson) => lesson.id)).toEqual(eligible.slice(-8).reverse().map((lesson) => lesson.id));
});

test("equal timestamps use newest insertion and marking old lessons does not promote them", () => {
  // Given two lessons created at the same timestamp.
  const first = lessons.add(input, T0), second = lessons.add(input, T0);
  // When the older lesson is marked.
  lessons.mark(first.id, "helped");
  // Then creation order remains the tie-breaker.
  expect(lessons.forRepo("/repo").map((lesson) => lesson.id)).toEqual([second.id, first.id]);
});

test("empty or unrelated journals yield no repo lessons", () => {
  // Given no journal; when selecting another scope; then no preamble data.
  expect(lessons.forRepo("/repo")).toEqual([]);
  lessons.add(input, T0);
  expect(lessons.forRepo("/unrelated")).toEqual([]);
});

test("invalid input and unknown IDs cannot mutate the journal", () => {
  // Given a valid persisted lesson.
  lessons.add(input, T0);
  const original = readFileSync(lessons.path, "utf8");
  // When boundary values violate the record contract.
  for (const rule of ["", "  ", "Injected\n## Heading", "x".repeat(401)]) {
    expect(() => lessons.add({ ...input, rule }, T0)).toThrow(LessonError);
  }
  expect(() => lessons.add({ ...input, lane: "../bad" }, T0)).toThrow(LessonError);
  expect(() => lessons.add({ ...input, evidence: "" }, T0)).toThrow(LessonError);
  expect(() => lessons.mark("missing", "helped")).toThrow(LessonError);
  // Then no partial record was written.
  expect(readFileSync(lessons.path, "utf8")).toBe(original);
});

test("malformed JSONL and immutable field changes are reported instead of discarded", () => {
  // Given a valid record followed by a damaged line.
  const added = lessons.add(input, T0);
  const original = readFileSync(lessons.path, "utf8");
  writeFileSync(lessons.path, `${original}not-json\n`);
  // When reading or adding; then corruption fails closed with a line number.
  expect(() => lessons.list()).toThrow(`${lessons.path}:2:`);
  expect(() => lessons.add(input, T0)).toThrow(LessonError);
  writeFileSync(lessons.path, `${original}${JSON.stringify({ ...added, cwd: "/other" })}\n`);
  expect(() => lessons.list()).toThrow("immutable fields changed");
});
