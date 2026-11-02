import { expect, test } from "bun:test";

import { freshnessTick, anchoredReportLine } from "../src/freshness.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

// Rendered rows in the shapes real panes show: an instruction, a prompt, argv, and a wrapped report.
const instruction = " truthful [REPORT] docs-research | milestone | current completed axes\n and remaining checks to lead lead:p1 using safe argv herdr pane run.";
const report = "[REPORT] pkg-release-fix | blocker | Attempt 2 failed. The amd64 build passed, then the registry denied the push again at 14:14:29Z; the arm64 build hit a";
const wrappedReport = ` ${report}\n CDN 500 and recovered; CI passed. Two attempts now show the same registry denial.`;

test.each([
  instruction,
  'Send a truthful [REPORT] docs-research | milestone | current completed axes and remaining checks',
  'Steering: [REPORT] docs-research | milestone | current completed axes',
  '❯ [REPORT] docs-research | milestone | current completed axes',
  ' "[REPORT] docs-research | milestone | current completed axes"',
  ' │ "[REPORT] docs-research | milestone | current completed axes"',
])("rejects instruction or quoted report row %#", (screen) => {
  // Given a rendered instruction, prompt, or argv rather than report output.
  // When the exported parser examines it.
  const parsed = anchoredReportLine(screen, "docs-research");
  // Then nothing is eligible for forwarding.
  expect(parsed).toBeNull();
});

test.each(["", " ", "  ", "\t"])("detects a standalone wrapped report with indentation %j", (prefix) => {
  // Given a real report with a rendered continuation and a trailing prompt.
  const screen = `${prefix}${wrappedReport.trimStart()}\n❯ `;
  // When the parser examines the screen.
  const parsed = anchoredReportLine(screen, "pkg-release-fix");
  // Then the existing first-rendered-line contract is preserved.
  expect(parsed).toBe(report);
});

test("keeps the last genuine report when a newer inline instruction appears", () => {
  // Given genuine reports followed by an inline example for the same lane.
  const first = "[REPORT] docs-research | milestone | source checks complete";
  const latest = "[REPORT] docs-research | question | delivery pending";
  const screen = `${first}\n ${latest}\n${instruction}`;
  // When the parser selects the last report.
  const parsed = anchoredReportLine(screen, "docs-research");
  // Then the instruction cannot replace the latest genuine output.
  expect(parsed).toBe(latest);
});

test("does not invoke the reply hook when the rendered screen only contains lead instructions", async () => {
  // Given a silent lane and an in-memory runner returning the failure rows.
  const state = withState();
  try {
    const now = Date.parse("2026-01-01T12:30:00Z");
    const world = newWorld();
    world.screen = instruction;
    const deps = depsFor(world, fakeClock(now), state.dir, { hooks: { threadReply: ["notify", "{thread}", "{text}"] } });
    await deps.registry.write({
      key: "docs-research", title: "research", thread: "chat:team/9",
      pane: "w:p7", brief: "/b.md", done: "merged acme/app#1",
      openedAt: "2026-01-01T12:00:00Z", lastNudgeAt: now,
    });
    // When the same exported sweep used by the CLI runs.
    const acts = await freshnessTick(deps, "/home/test");
    // Then no report is posted and no external reply command is invoked.
    expect(acts.map((act) => act.kind)).toEqual(["no-report"]);
    expect(world.calls.filter((call) => call[0] === "notify")).toEqual([]);
  } finally {
    state.done();
  }
});

test("rejects the failure row and detects the real report through a Bun script import", async () => {
  // Given captured failure and real output rows, passed as data to a new process.
  const script = `import { anchoredReportLine } from "./src/freshness.ts";
console.log(JSON.stringify([
  anchoredReportLine(process.argv[1], "docs-research"),
  anchoredReportLine(process.argv[2], "pkg-release-fix")
]));`;
  // When Bun executes the actual exported parser script surface.
  const child = Bun.spawn([process.execPath, "-e", script, instruction, wrappedReport], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  // Then the process succeeds and distinguishes the two real input classes.
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual([null, report]);
});

test("template shapes from #29 are not reports; the emitted report still wins", () => {
  const emitted = "[REPORT] demo-lane | milestone | checks passed";
  const screen = [
    emitted,
    'echo "[REPORT] demo-lane | milestone | $message"',
    'printf "[REPORT] demo-lane | milestone | %s\\n" "$msg"',
    "[REPORT] demo-lane | milestone | $message",
    "[REPORT] demo-lane | done | %s",
    "[REPORT] demo-lane | milestone | ${message}",
  ].join("\n");
  expect(anchoredReportLine(screen, "demo-lane")).toBe(emitted);
  expect(anchoredReportLine("[REPORT] demo-lane | milestone | $message", "demo-lane")).toBeNull();
  expect(anchoredReportLine("[REPORT] demo-lane | done | %s", "demo-lane")).toBeNull();
  expect(anchoredReportLine("[REPORT] demo-lane | milestone | set $HOME in docs", "demo-lane")).toBe("[REPORT] demo-lane | milestone | set $HOME in docs");
  expect(anchoredReportLine("[REPORT] demo-lane | done | 100% of checks green", "demo-lane")).toBe("[REPORT] demo-lane | done | 100% of checks green");
});

test("a [REPORT] that is a whole quoted argv element is a report; prose quoting the grammar and templates are not", () => {
  // Given the argv row a lane's own pane shows after sending its report the documented way.
  const argv = '["herdr", "pane", "run", "lead:p1", "[REPORT] demo-lane | milestone | tests pass, PR opened"]';
  // When it is parsed alone, or in single quotes inside a call; then the element is the report.
  expect(anchoredReportLine(argv, "demo-lane")).toBe("[REPORT] demo-lane | milestone | tests pass, PR opened");
  expect(anchoredReportLine("Bun.spawn(['herdr', 'pane', 'run', 'lead:p1', '[REPORT] demo-lane | done | merged as abc123'])", "demo-lane")).toBe("[REPORT] demo-lane | done | merged as abc123");
  // Then prose that quotes the grammar mid-sentence, and #29 templates inside argv, are still dropped.
  for (const row of [
    'Send "[REPORT] demo-lane | milestone | tests pass" to the lead pane',
    'echo "[REPORT] demo-lane | milestone | tests pass"',
    'Example from the docs: run, "[REPORT] demo-lane | milestone | all tests green", then wait.',
    '["herdr", "pane", "run", lead, "[REPORT] demo-lane | milestone | unquoted element before it"]',
    '["[REPORT] demo-lane | milestone | report not last", "herdr"]',
    '["herdr", "pane", "run", "lead:p1", "[REPORT] demo-lane | milestone | $message"]',
    '["herdr", "pane", "run", "lead:p1", "[REPORT] demo-lane | milestone | %s"]',
    '["herdr", "pane", "run", "lead:p1", "[REPORT] demo-lane | milestone | ${text}"]',
  ]) expect(anchoredReportLine(row, "demo-lane")).toBeNull();
  // And the argv report stays the latest one when an instruction follows it.
  expect(anchoredReportLine(`${argv}\nSend "[REPORT] demo-lane | milestone | next step" to the lead`, "demo-lane")).toBe("[REPORT] demo-lane | milestone | tests pass, PR opened");
});

test("the screen grammar reads the same kinds as dori report --kind, halted and question included", () => {
  for (const kind of ["milestone", "blocker", "halted", "question", "done"]) {
    expect(anchoredReportLine(`[REPORT] demo-lane | ${kind} | owner said stop`, "demo-lane")).toBe(`[REPORT] demo-lane | ${kind} | owner said stop`);
  }
});

test("a quoted placeholder is a template, but a placeholder after a later pipe is real report text", () => {
  expect(anchoredReportLine('[REPORT] demo-lane | milestone | "$text"', "demo-lane")).toBeNull();
  expect(anchoredReportLine("[REPORT] demo-lane | milestone | `<what>`", "demo-lane")).toBeNull();
  expect(anchoredReportLine("[REPORT] demo-lane | milestone | deployed api | %s", "demo-lane")).toBe("[REPORT] demo-lane | milestone | deployed api | %s");
});
