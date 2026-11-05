import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { renderUntilStable, Worklog, WORKLOG_MARKER, WorklogError } from "../src/worklog.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const T0 = Date.parse("2026-11-04T00:00:00Z");

const cliIn = (dir: string) => {
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  return (...args: string[]) => run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${dir}`, process.execPath, cli, ...args]);
};

test("add, next, note and close build one markdown heading per item with Source, Next, Notes and Result", () => {
  // Given a worklog with one item taken through its whole life and one still open.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const done = log.add("Rotate the bot token", "slack:D1/100.1", T0);
    log.next(done.id, "ask the owner for the new token", T0 + 1);
    log.note(done.id, "owner: rotate before Friday", T0 + 2);
    const closed = log.close(done.id, "rotated; inbound reads back", T0 + 3);
    const open = log.add("Fix the flaky upload test", "slack:D1/100.2", T0 + 4);
    // Then the returned item, the reread record and the rendered file agree.
    expect(closed).toEqual({
      id: done.id, title: "Rotate the bot token", source: "slack:D1/100.1", openedAt: new Date(T0).toISOString(),
      next: "ask the owner for the new token", notes: [{ at: new Date(T0 + 2).toISOString(), text: "owner: rotate before Friday" }],
      closedAt: new Date(T0 + 3).toISOString(), result: "rotated; inbound reads back",
    });
    expect(log.open().map((item) => item.id)).toEqual([open.id]);
    expect(readFileSync(log.markdownPath, "utf8")).toBe(`${WORKLOG_MARKER}
# Worklog

## Open

### ${open.id} Fix the flaky upload test
- Source: slack:D1/100.2
- Opened: 2026-11-04T00:00:00.004Z
- Next: (none yet)

## Closed

### ${done.id} Rotate the bot token
- Source: slack:D1/100.1
- Opened: 2026-11-04T00:00:00.000Z
- Next: ask the owner for the new token
- Notes:
  - 2026-11-04T00:00:00.002Z owner: rotate before Friday
- Closed: 2026-11-04T00:00:00.003Z
- Result: rotated; inbound reads back
`);
  } finally { state.done(); }
});

test("an unknown or closed item, or a multi-line text, is refused and writes nothing", () => {
  // Given one closed item.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const item = log.add("Done already", "slack:D1/1.1", T0);
    log.close(item.id, "shipped", T0 + 1);
    const before = [readFileSync(log.path, "utf8"), readFileSync(log.markdownPath, "utf8")];
    // When changing it, an unknown id, or adding a two-line title; then each is refused and both files are unchanged.
    expect(() => log.next(item.id, "more", T0 + 2)).toThrow(`worklog item ${item.id} is closed: shipped`);
    expect(() => log.note("0000beef", "x", T0 + 2)).toThrow("worklog item not found: 0000beef");
    expect(() => log.add("two\nlines", "slack:D1/1.2", T0 + 2)).toThrow(WorklogError);
    expect([readFileSync(log.path, "utf8"), readFileSync(log.markdownPath, "utf8")]).toEqual(before);
  } finally { state.done(); }
});

test("a worklog.md the command did not write is never replaced, and the record is not touched", () => {
  // Given hand-written notes at the path the command renders to.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    writeFileSync(log.markdownPath, "# My notes\n- keep me\n");
    // When adding an item; then it is refused, the notes are intact, and no record was appended.
    expect(() => log.add("New request", "slack:D1/2.1", T0)).toThrow("was not written by dori worklog; move it aside");
    expect(readFileSync(log.markdownPath, "utf8")).toBe("# My notes\n- keep me\n");
    expect(existsSync(log.path)).toBe(false);
  } finally { state.done(); }
});

test("concurrent CLI adds from separate processes lose no item, in the record or in worklog.md", async () => {
  // Given an empty state dir and 12 processes adding at once.
  const state = withState();
  try {
    const invoke = cliIn(state.dir);
    const count = 12;
    const results = await Promise.all(Array.from({ length: count }, (_, i) => invoke("worklog", "add", `request ${i}`, "--source", `slack:D1/9.${i}`)));
    // Then every process succeeded, every item is in the record once, and the last render holds all of them.
    expect(results.map((r) => [r.code, r.err])).toEqual(Array.from({ length: count }, () => [0, ""]));
    const ids = results.map((r) => (JSON.parse(r.out) as { id: string }).id);
    const log = new Worklog(state.dir);
    const read = log.read();
    expect(read.problems).toEqual([]);
    expect(read.items.map((item) => item.id).sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(count);
    const markdown = readFileSync(log.markdownPath, "utf8");
    for (const id of ids) expect(markdown).toContain(`### ${id} request `);
  } finally { state.done(); }
});

test("a render that raced another writer's append publishes again, so the last view holds every record", () => {
  // Given another writer that appends after our read and publishes its full view before our stale one lands.
  let record = "a\n";
  const published: string[] = [];
  // When we publish; then our stale view is followed by a full one, so the last view holds both records.
  const final = renderUntilStable(() => Buffer.from(record), (view) => {
    if (!published.length) {
      record += "b\n";
      published.push(record);
    }
    published.push(view);
  }, () => Buffer.byteLength(record));
  expect(published).toEqual(["a\nb\n", "a\n", "a\nb\n"]);
  expect(final).toBe("a\nb\n");
});

test("a record cut off inside a multi-byte character renders once, and later CLI changes do not hang", async () => {
  // Given a record whose last line stops after the first byte of a three-byte character.
  const cut = Buffer.concat([Buffer.from('{"op":"add","title":"'), Buffer.from("一").subarray(0, 1)]);
  const views: string[] = [];
  // When rendering it; then it is published once, since the sizes are compared in bytes, not after decoding.
  renderUntilStable(() => cut, (view) => {
    views.push(view);
    if (views.length > 3) throw new Error("rendered again and again");
  }, () => cut.length);
  expect(views).toHaveLength(1);
  // And given the same tear in a real record, each later CLI change finishes well inside its timeout.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const kept = log.add("한글 제목", "slack:D1/5.1", T0);
    writeFileSync(log.path, Buffer.concat([readFileSync(log.path), cut]));
    cliIn(state.dir);
    const invoke = (...args: string[]) => run(["env", `DORI_CONFIG=${join(state.dir, "config.json")}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args], { timeoutMs: 10_000 });
    const added = await invoke("worklog", "add", "새 요청", "--source", "slack:D1/5.2");
    expect([added.code, added.err]).toEqual([0, ""]);
    const id = (JSON.parse(added.out) as { id: string }).id;
    expect((await invoke("worklog", "next", kept.id, "다음")).code).toBe(0);
    expect((await invoke("worklog", "close", id, "--result", "끝")).code).toBe(0);
    expect(log.open().map((item) => [item.id, item.next])).toEqual([[kept.id, "다음"]]);
    expect(readFileSync(log.markdownPath, "utf8")).toContain(`### ${id} 새 요청`);
  } finally { state.done(); }
}, 40_000);

test("C1 controls, NEL and the Unicode line and paragraph separators are refused in a text and in the record", () => {
  // Given an empty worklog.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    // When adding a title holding each; then each is refused and nothing is written.
    for (const bad of ["\x80", "\x85", "\x9b", "\x9f", "\u2028", "\u2029"]) {
      expect(() => log.add(`before${bad}after`, "slack:D1/6.1", T0)).toThrow(WorklogError);
    }
    expect(existsSync(log.path)).toBe(false);
    // And a record line holding one, written by hand, is skipped and named.
    writeFileSync(log.path, `${JSON.stringify({ op: "add", id: "0000beef", at: new Date(T0).toISOString(), title: "a\u2028b", source: "s" })}\n`);
    const read = log.read();
    expect(read.items).toEqual([]);
    expect(read.problems).toEqual([`${log.path}:1: worklog field "title" must be one nonempty line of at most 200 characters`]);
  } finally { state.done(); }
});

test("when two writers close one item, the first close wins and the second, and any change after it, is flagged", () => {
  // Given an item closed once, then a second close and a note appended by writers that saw it still open.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const item = log.add("Reply to the owner", "slack:D1/7.1", T0);
    log.close(item.id, "first answer", T0 + 1);
    const late = (op: string, field: string, text: string, at: number) => JSON.stringify({ op, id: item.id, at: new Date(at).toISOString(), [field]: text });
    writeFileSync(log.path, `${readFileSync(log.path, "utf8")}${late("close", "result", "second answer", T0 + 2)}\n${late("note", "text", "late note", T0 + 3)}\n`);
    // When reading; then the first result stands, no late note is kept, and both late lines are named.
    const read = log.read();
    expect(read.items.map((i) => [i.result, i.closedAt, i.notes])).toEqual([["first answer", new Date(T0 + 1).toISOString(), []]]);
    expect(read.problems).toEqual([
      `${log.path}:3: worklog item ${item.id} was already closed; close ignored`,
      `${log.path}:4: worklog item ${item.id} was already closed; note ignored`,
    ]);
  } finally { state.done(); }
});

test("CLI next, close and list --open read back across processes; a missing flag fails", async () => {
  // Given two items added through the CLI.
  const state = withState();
  try {
    const invoke = cliIn(state.dir);
    const first = JSON.parse((await invoke("worklog", "add", "First", "--source", "slack:D1/3.1")).out) as { id: string };
    const second = JSON.parse((await invoke("worklog", "add", "Second", "--source", "slack:D1/3.2")).out) as { id: string };
    // When one gets a next step (unquoted words) and the other is closed.
    expect((await invoke("worklog", "next", first.id, "merge", "after", "CI")).code).toBe(0);
    expect((await invoke("worklog", "close", second.id, "--result", "answered")).code).toBe(0);
    // Then list --open shows only the first, with its next step; close without --result and add without --source fail.
    const listed = await invoke("worklog", "list", "--open");
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.out) as { id: string; next: string }[]).map((item) => [item.id, item.next])).toEqual([[first.id, "merge after CI"]]);
    expect((await invoke("worklog", "close", first.id)).code).toBe(1);
    expect((await invoke("worklog", "add", "No source")).code).toBe(1);
    expect(new Worklog(state.dir).read().items).toHaveLength(2);
  } finally { state.done(); }
});

test("a torn last line stays one damaged line; the next record starts fresh and list warns", async () => {
  // Given a record cut off mid-write after one good item.
  const state = withState();
  try {
    const log = new Worklog(state.dir);
    const kept = log.add("Kept", "slack:D1/4.1", T0);
    writeFileSync(log.path, `${readFileSync(log.path, "utf8")}{"op":"add","id":"aaaa`);
    // When another item is added and the CLI lists.
    const added = log.add("After the tear", "slack:D1/4.2", T0 + 1);
    const listed = await cliIn(state.dir)("worklog", "list");
    // Then both whole items survive and the torn line is named on stderr.
    expect(log.read().items.map((item) => item.id)).toEqual([kept.id, added.id]);
    expect(listed.code).toBe(0);
    expect(listed.err).toContain(`WORKLOG_WARNING ${log.path}:2: `);
  } finally { state.done(); }
});
