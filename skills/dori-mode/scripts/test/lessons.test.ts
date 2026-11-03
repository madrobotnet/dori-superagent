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
  expect(new Lessons(state.dir).read().lessons).toEqual([{ ...added, outcome: "helped" }]);
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
  const selected = lessons.forRepo("/repo/../repo/").lessons;
  // Then scope, filtering, ordering and cap are all observable in record IDs.
  expect(selected.map((lesson) => lesson.id)).toEqual(eligible.slice(-8).reverse().map((lesson) => lesson.id));
});

test("equal timestamps use newest insertion and marking old lessons does not promote them", () => {
  // Given two lessons created at the same timestamp.
  const first = lessons.add(input, T0), second = lessons.add(input, T0);
  // When the older lesson is marked.
  lessons.mark(first.id, "helped");
  // Then creation order remains the tie-breaker.
  expect(lessons.forRepo("/repo").lessons.map((lesson) => lesson.id)).toEqual([second.id, first.id]);
});

test("empty or unrelated journals yield no repo lessons", () => {
  // Given no journal; when selecting another scope; then no preamble data.
  expect(lessons.forRepo("/repo").lessons).toEqual([]);
  lessons.add(input, T0);
  expect(lessons.forRepo("/unrelated").lessons).toEqual([]);
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

test("a damaged line is named and skipped; the lessons around it still load and add still works", () => {
  // Given a valid record followed by a line that is not JSON.
  const first = lessons.add(input, T0);
  writeFileSync(lessons.path, `${readFileSync(lessons.path, "utf8")}not-json\n`);
  // When another lesson is added and the journal is read.
  const second = lessons.add({ ...input, rule: "Second rule" }, T0 + 1);
  const read = lessons.read();
  // Then both lessons load and the bad line is reported by its number.
  expect(read.lessons.map((lesson) => lesson.id)).toEqual([second.id, first.id]);
  expect(read.problems).toEqual([expect.stringContaining(`${lessons.path}:2: `)]);
});

test("a torn last line does not swallow the next record", () => {
  // Given a writer that stopped halfway through a record.
  const first = lessons.add(input, T0);
  writeFileSync(lessons.path, `${readFileSync(lessons.path, "utf8")}{"id":"torn`);
  // When the next lesson is added.
  const second = lessons.add({ ...input, rule: "After the tear" }, T0 + 1);
  // Then it lands on its own line and only the torn line is reported.
  const read = lessons.read();
  expect(read.lessons.map((lesson) => lesson.id)).toEqual([second.id, first.id]);
  expect(read.problems).toEqual([expect.stringContaining(`${lessons.path}:2: `)]);
});

test("a time that is not the canonical ISO form is a damaged line", () => {
  // Given one valid record and copies whose time Date.parse accepts but toISOString never writes.
  const added = lessons.add(input, T0);
  const bad = ["0", "2026-10-29", "Thu, 29 Oct 2026 00:00:00 GMT", "2026-10-29T00:00:00Z"];
  writeFileSync(lessons.path, `${readFileSync(lessons.path, "utf8")}${bad.map((at) => JSON.stringify({ ...added, id: crypto.randomUUID(), at })).join("\n")}\n`);
  // When reading; then only the canonical record loads and each other line is named by its field.
  const read = lessons.read();
  expect(read.lessons).toEqual([added]);
  expect(read.problems).toEqual(bad.map((_, i) => expect.stringContaining(`:${i + 2}: lesson field "at"`)));
});

test("an id that is not the lowercase UUID randomUUID writes is a damaged line", () => {
  // Given one valid record and copies with ids of the right length but the wrong shape.
  const added = lessons.add(input, T0);
  const bad = ["-".repeat(36), "0".repeat(36), crypto.randomUUID().toUpperCase()];
  writeFileSync(lessons.path, `${readFileSync(lessons.path, "utf8")}${bad.map((id) => JSON.stringify({ ...added, id })).join("\n")}\n`);
  // When reading; then only the real record loads and each other line is named by its field.
  const read = lessons.read();
  expect(read.lessons).toEqual([added]);
  expect(read.problems).toEqual(bad.map((_, i) => expect.stringContaining(`:${i + 2}: lesson field "id"`)));
});

test("a malformed or unknown field is rejected by name, and an immutable change keeps the first record", () => {
  // Given one valid record and three bad copies of it.
  const added = lessons.add(input, T0);
  const original = readFileSync(lessons.path, "utf8");
  writeFileSync(lessons.path, [
    original.trimEnd(),
    JSON.stringify({ ...added, outcome: "done" }),
    JSON.stringify({ ...added, extra: 1 }),
    JSON.stringify({ ...added, cwd: "/other" }),
  ].join("\n") + "\n");
  // When reading.
  const read = lessons.read();
  // Then each line's problem names its field, and the first record stands.
  expect(read.lessons).toEqual([added]);
  expect(read.problems).toEqual([
    expect.stringContaining(`:2: lesson field "outcome"`),
    expect.stringContaining(`:3: unknown lesson field "extra"`),
    expect.stringContaining(`:4: lesson field "cwd" changed for ${added.id}`),
  ]);
});
