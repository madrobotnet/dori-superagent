import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { cliCommand, footer } from "../src/launch.ts";
import type { Runner, RunOptions } from "../src/run.ts";
import { checkPr as checkWith, type CommitIdentity, formatVerifyPr, verifyPr, type PrCommit, type PrSnapshot, type VerifyPrOptions } from "../src/verify-pr.ts";

// Synthetic fixtures in the shape of GitHub's API, one per case; see each file's commits for the case it covers.
const FIXTURES = ["fix-with-own-ui-test", "fix-then-untested-copy-fix", "tests-in-later-commits", "follow-up-fixes-without-tests",
  "fixture-file-is-not-a-test", "wrong-commit-email", "release-chore", "browser-test-only"] as const;
const fixture = (name: string): PrSnapshot => JSON.parse(readFileSync(new URL(`./fixtures/verify-pr/${name}.json`, import.meta.url), "utf8"));
const IDENTITY: CommitIdentity = { name: "Example Dev", email: "12345+example@users.noreply.github.com" };
const withIdentity: VerifyPrOptions = { expectedIdentity: IDENTITY };
const checkPr = (p: PrSnapshot, options: VerifyPrOptions = {}) => checkWith(p, { ...withIdentity, ...options });
const shaOf = (p: PrSnapshot, message: string): string => p.commits.find((c) => c.commit.message === message)?.sha ?? "";
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const commit = (files: PrCommit["files"], message = "fix(ui): preserve pending work", id = sha): PrCommit => ({
  sha: id, commit: { message, author: IDENTITY, committer: IDENTITY }, files,
});
const source = { filename: "src/features/Dialog.tsx", status: "modified" };
const changedTest = { filename: "src/features/Dialog.test.tsx", status: "modified", patch: "+test('pending', async () => { await ready; });" };
const snapshot = (commits: readonly PrCommit[] = [commit([source, changedTest])], body: string | null = null): PrSnapshot =>
  ({ repo: "acme/app", number: 99, head: commits.at(-1)?.sha ?? sha, body, commits, files: commits.flatMap((c) => c.files) });
const json = (value: unknown) => ({ code: 0, out: JSON.stringify(value), err: "" });
const recordedRunner = (p: PrSnapshot): { run: Runner; calls: { argv: readonly string[]; opts?: RunOptions }[] } => {
  const calls: { argv: readonly string[]; opts?: RunOptions }[] = [];
  const run: Runner = async (argv, opts) => {
    calls.push({ argv, opts });
    expect(argv.slice(0, 5)).toEqual(["gh", "api", "--method", "GET", argv[4]!]);
    const endpoint = argv[4]!;
    if (endpoint === `repos/${p.repo}/pulls/${p.number}`) return json({ body: p.body, head: { sha: p.head }, commits: p.commits.length });
    if (endpoint.includes(`/pulls/${p.number}/commits?`)) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      return json(p.commits.slice((page - 1) * 100, page * 100).map((c) => ({ sha: c.sha })));
    }
    if (endpoint.includes(`/pulls/${p.number}/files?`)) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      return json(p.files.slice((page - 1) * 100, page * 100));
    }
    const c = p.commits.find((c) => endpoint.startsWith(`repos/${p.repo}/commits/${c.sha}?`));
    if (c) {
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      return json({ ...c, files: c.files.slice((page - 1) * 100, page * 100) });
    }
    throw new Error(`unexpected read ${endpoint}`);
  };
  return { run, calls };
};

for (const name of FIXTURES) {
  test(`fixture ${name} is checked using every commit's files and Git identities`, async () => {
    const p = fixture(name);
    const fake = recordedRunner(p);
    const result = await verifyPr(p.repo, p.number, fake.run, withIdentity);
    expect(result.ok).toBe(name !== "wrong-commit-email");
    expect(result.head).toBe(p.head);
    expect(fake.calls.filter((c) => c.argv[4]!.includes(`/commits/`))).toHaveLength(p.commits.length);
    expect(fake.calls.some((c) => c.argv[4]!.includes("/files"))).toBe(true);
    expect(fake.calls.filter((c) => c.argv[4] === `repos/${p.repo}/pulls/${p.number}`)).toHaveLength(2);
  });
}

test("fixes whose tests land in other commits pass with one warning per untested fix commit", () => {
  const p = fixture("tests-in-later-commits");
  const result = checkPr(p);
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings).toHaveLength(2);
  for (const message of ["fix(capture): retain the dialog while saving", "fix(notes): tighten the tag filter boundary"]) {
    expect(result.warnings.some((e) => e.startsWith(shaOf(p, message)) && e.includes("without its own"))).toBe(true);
  }
  expect(result.asyncUiTests).toContain("src/features/capture/CaptureDialog.test.tsx");
  expect(result.asyncUiTests).toContain("src/features/inbox/SnoozeSheet.test.tsx");
});

test("a fixture file next to a test is not a test, and a wrong email names both roles", () => {
  expect(checkPr(fixture("fixture-file-is-not-a-test")).asyncUiTests).not.toContain("src/features/settings/Templates.fixture.tsx");
  const wrong = checkPr(fixture("wrong-commit-email"));
  expect(wrong.errors.map((e) => e.split(": ")[1]?.split(" ")[1])).toEqual(["author", "committer"]);
  expect(checkPr(fixture("follow-up-fixes-without-tests")).warnings).toHaveLength(3);
  expect(checkPr(fixture("release-chore")).warnings).toEqual([]);
});

test("a later test commit satisfies the PR gate but keeps a per-commit warning", () => {
  const result = checkPr(snapshot([commit([source]), commit([changedTest], "test(ui): cover pending work", otherSha)]));
  expect(result.ok).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.warnings[0]).toStartWith(sha);
});

test("a synthetic source fix without any PR test change fails unless explicitly waived", () => {
  const p = fixture("source-fix-without-tests");
  expect(checkPr(p).ok).toBe(false);
  expect(checkPr(p).errors).toHaveLength(1);
  const waived = checkPr({ ...p, body: "No test: CSS-only presentation change" });
  expect(waived.ok).toBe(true);
  expect(waived.warnings).toHaveLength(2);
  expect(checkPr({ ...snapshot(), files: [source] }).ok).toBe(false);
});

test("fixtures, source maps, and test helpers do not stand in for changed executable tests", () => {
  for (const filename of ["test/fixtures/example.test.ts", "test/helpers/browser.ts", "test/fakes.ts", "test/setup.ts", "src/example.test.ts.snap", "src/example.test.ts.map"]) {
    expect(checkPr(snapshot([commit([source, { filename, status: "added" }])])).ok).toBe(false);
  }
});

test("a real test whose name is helpers, mocks, fakes or fixture still counts; their directories do not", () => {
  for (const filename of ["test/helpers.test.ts", "src/mocks.test.ts", "test/fakes.spec.js", "tests/fixture_test.py", "test/setup.test.ts"]) {
    expect(checkPr(snapshot([commit([source, { filename, status: "added" }])])).ok).toBe(true);
  }
  for (const filename of ["test/mocks/api.test.ts", "src/helpers/format.test.ts"]) {
    expect(checkPr(snapshot([commit([source, { filename, status: "added" }])])).ok).toBe(false);
  }
});

test("an added or changed test in the fix commit passes, but deleting a test does not", () => {
  for (const status of ["added", "modified", "renamed", "copied", "changed"]) {
    expect(checkPr(snapshot([commit([source, { ...changedTest, status }])])).ok).toBe(true);
  }
  const result = checkPr(snapshot([commit([source, { ...changedTest, status: "removed" }])]));
  expect(result.ok).toBe(false);
  expect(result.asyncUiTests).toEqual([]);
});

test("only an explicit nonempty No test line exempts source fixes, never identity", () => {
  for (const body of ["No test: presentation-only color adjustment", "## Verification\nNo test:  generated source; exercised by upstream suite\r\n"]) {
    expect(checkPr(snapshot([commit([source])], body)).ok).toBe(true);
  }
  for (const body of ["No test:", "No test:   \nSome unrelated reason", "We have No test: reason", "No tests: reason", null]) {
    expect(checkPr(snapshot([commit([source])], body)).ok).toBe(false);
  }
  const bad = commit([source]);
  expect(checkPr(snapshot([{ ...bad, commit: { ...bad.commit, committer: null } }], "No test: copy change")).ok).toBe(false);
});

test("both identities need nonempty names and the expected email", () => {
  for (const role of ["author", "committer"] as const) {
    for (const identity of [null, { name: "", email: IDENTITY.email }, { name: IDENTITY.name, email: "" }, { name: IDENTITY.name, email: "wrong@example.com" }]) {
      const c = commit([source, changedTest]);
      const result = checkPr(snapshot([{ ...c, commit: { ...c.commit, [role]: identity } }]));
      expect(result.ok).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain(role);
    }
  }
});

test("emails match whatever their case", () => {
  const c = commit([source, changedTest]);
  const upper = { name: IDENTITY.name, email: IDENTITY.email.toUpperCase() };
  expect(checkPr(snapshot([{ ...c, commit: { ...c.commit, author: upper, committer: upper } }])).ok).toBe(true);
  expect(checkPr(snapshot([c]), { expectedIdentity: { name: IDENTITY.name, email: "12345+Example@Users.NoReply.GitHub.com" } }).ok).toBe(true);
});

test("names may vary and GitHub noreply is accepted only as a merge committer", () => {
  const c = commit([source, changedTest]);
  const renamed = { name: "example", email: IDENTITY.email };
  const github = { name: "GitHub", email: "noreply@github.com" };
  expect(checkPr(snapshot([{ ...c, commit: { ...c.commit, author: renamed, committer: renamed } }])).ok).toBe(true);
  const merge = { ...c, parents: [{ sha }, { sha: otherSha }], commit: { ...c.commit, committer: github } };
  expect(checkPr(snapshot([merge])).ok).toBe(true);
  expect(checkPr(snapshot([{ ...merge, parents: [{ sha }] }])).ok).toBe(false);
  expect(checkPr(snapshot([{ ...merge, commit: { ...merge.commit, author: github } }])).ok).toBe(false);
  expect(checkPr(fixture("browser-test-only")).warnings).toEqual([]);
});

test("a configured identity without a string name or email fails before a GitHub read, without throwing", async () => {
  const run: Runner = async () => { throw new Error("gh must not be called"); };
  for (const bad of [{ email: IDENTITY.email }, { name: "Example Dev", email: 12345 }, null]) {
    const result = await verifyPr("acme/app", 99, run, { expectedIdentity: bad as unknown as CommitIdentity });
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("repoIdentities");
  }
});

test("a repo with no configured identity fails before a GitHub read", async () => {
  const p = { ...snapshot(), repo: "acme/other" };
  const fake = recordedRunner(p);
  expect((await verifyPr(p.repo, p.number, fake.run)).ok).toBe(false);
  expect(fake.calls).toHaveLength(0);
  expect((await verifyPr(p.repo, p.number, fake.run, { expectedIdentity: IDENTITY })).ok).toBe(true);
  expect(checkPr(snapshot(), { expectedIdentity: { name: "", email: "" } }).ok).toBe(false);
});

test("fix source classification includes styles, scripts, deletions, and old renamed source paths", () => {
  for (const file of [
    { filename: "src/ui.css", status: "modified" },
    { filename: "distribution/release/collect.mjs", status: "modified" },
    { filename: "src/old.ts", status: "removed" },
    { filename: "docs/retired.txt", previous_filename: "src/old.ts", status: "renamed" },
  ]) expect(checkPr(snapshot([commit([file])])).ok).toBe(false);
  for (const file of [{ filename: "docs/example.ts", status: "modified" }, { filename: "README.md", status: "modified" }]) {
    expect(checkPr(snapshot([commit([file])])).ok).toBe(true);
  }
  expect(checkPr(snapshot([commit([source], "feat(ui): add dialog")])).ok).toBe(true);
  expect(checkPr(snapshot([commit([source], "fix(ui)!: change dialog contract")])).ok).toBe(false);
});

test("an unscoped fix: or fix!: commit that touches source needs a test like a scoped one", () => {
  for (const message of ["fix: deliver to omo panes", "fix!: change dialog contract"]) {
    expect(checkPr(snapshot([commit([source], message)])).ok).toBe(false);
    expect(checkPr(snapshot([commit([source, changedTest], message)])).ok).toBe(true);
  }
  expect(checkPr(snapshot([commit([source], "fixup: tidy")])).ok).toBe(true);
});

test("async UI candidates include browser tests with .ts extensions, are deduplicated, and are never run", async () => {
  const p = fixture("browser-test-only");
  const fake = recordedRunner(p);
  const result = await verifyPr(p.repo, p.number, fake.run, { ...withIdentity, loopCount: 50, cwd: "/owned/checkout" });
  expect(result.ok).toBe(true);
  expect(result.asyncUiTests).toEqual(["src/features/settings/Templates.test.ts"]);
  expect(result.loopCommand).toContain('[ "$i" -lt 50 ]');
  expect(result.loopCommand).toContain("bun --no-env-file test './src/features/settings/Templates.test.ts'");
  expect(result.loopCommand).toContain("|| exit $?");
  expect(fake.calls.every((c) => c.argv[0] === "gh" && c.opts?.cwd === "/owned/checkout" && c.opts?.timeoutMs === 120_000)).toBe(true);
  expect(formatVerifyPr(result)).toContain(p.head);
});

test("loop candidates include DOM patch evidence outside UI directories and shell-quote paths", () => {
  const file = { filename: "test/we'ird.test.ts", status: "modified", patch: "+const browser = new Bun.WebView();\n+await browser.navigate('/');" };
  const result = checkPr(snapshot([commit([file], "test: browser regression")]));
  expect(result.asyncUiTests).toEqual([file.filename]);
  expect(result.loopCommand).toContain("'./test/we'\\''ird.test.ts'");
  expect(checkPr(snapshot([commit([{ filename: "src/server/service.test.ts", status: "added" }], "test: server")])).loopCommand).toBeUndefined();
});

test("a later deletion or rename does not leave an unrunnable old test in the loop command", () => {
  const removed = commit([{ ...changedTest, status: "removed" }], "test(ui): retire old regression", otherSha);
  expect(checkPr(snapshot([commit([changedTest], "test(ui): add regression"), removed])).asyncUiTests).toEqual([]);
  const renamed = commit([{ ...changedTest, filename: "src/features/NewDialog.test.tsx", previous_filename: changedTest.filename, status: "renamed" }], "test(ui): rename regression", otherSha);
  expect(checkPr(snapshot([commit([changedTest], "test(ui): add regression"), renamed])).asyncUiTests).toEqual(["src/features/NewDialog.test.tsx"]);
});

test("invalid inputs fail without calling gh", async () => {
  const fake = recordedRunner(snapshot());
  for (const [repo, number, loopCount] of [["--help", 1, 20], ["acme/app", 0, 20], ["acme/app", 1.5, 20], ["acme/app", 1, 0], ["acme/app", 1, Infinity]] as const) {
    expect((await verifyPr(repo, number, fake.run, { ...withIdentity, loopCount })).ok).toBe(false);
  }
  expect(fake.calls).toHaveLength(0);
});

test("GitHub command failures and invalid JSON fail closed", async () => {
  for (const r of [{ code: 1, out: "", err: "authentication failed" }, { code: 0, out: "not json", err: "" }]) {
    expect((await verifyPr("acme/app", 3, async () => r, withIdentity)).ok).toBe(false);
  }
  expect((await verifyPr("acme/app", 3, async () => { throw new Error("offline"); }, withIdentity)).ok).toBe(false);
});

test("missing metadata, incomplete commit lists, and missing commit identities fail closed", async () => {
  const p = snapshot();
  for (const alter of [
    (endpoint: string) => endpoint.endsWith("/pulls/99") ? { head: { sha }, commits: 1 } : undefined,
    (endpoint: string) => endpoint.includes("/pulls/99/commits?") ? [] : undefined,
    (endpoint: string) => endpoint.includes(`/commits/${sha}?`) ? { sha, commit: { message: "fix(ui): bad" }, files: [] } : undefined,
    (endpoint: string) => endpoint.includes(`/commits/${sha}?`) ? { ...p.commits[0], files: undefined } : undefined,
  ]) {
    const fake = recordedRunner(p);
    const run: Runner = async (argv, opts) => {
      const value = alter(argv[4]!);
      return value === undefined ? fake.run(argv, opts) : json(value);
    };
    expect((await verifyPr(p.repo, p.number, run, withIdentity)).ok).toBe(false);
  }
});

test("commit-file pagination finds a test beyond the first hundred files", async () => {
  const files = [...Array.from({ length: 100 }, (_, i) => ({ filename: `src/file-${i}.ts`, status: "modified" })), changedTest];
  const p = snapshot([commit(files)]);
  const fake = recordedRunner(p);
  expect((await verifyPr(p.repo, p.number, fake.run, withIdentity)).ok).toBe(true);
  expect(fake.calls.some((c) => c.argv[4]!.includes(`/commits/${sha}?per_page=100&page=2`))).toBe(true);
});

test("PR commit pagination checks identities beyond the first hundred commits", async () => {
  const commits = Array.from({ length: 101 }, (_, i) => commit([changedTest], "test(ui): regression", i.toString(16).padStart(40, "0")));
  const last = commits[100]!;
  commits[100] = { ...last, commit: { ...last.commit, author: null } };
  const p = snapshot(commits);
  const fake = recordedRunner(p);
  const result = await verifyPr(p.repo, p.number, fake.run, withIdentity);
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toStartWith(last.sha);
});

test("a head or body change during verification is not certified", async () => {
  for (const change of [{ head: { sha: otherSha } }, { body: "No test: new exception" }, { commits: 2 }]) {
    const p = snapshot();
    const fake = recordedRunner(p);
    let reads = 0;
    const run: Runner = async (argv, opts) => {
      if (argv[4] === `repos/${p.repo}/pulls/${p.number}` && ++reads === 2) return json({ body: p.body, head: { sha: p.head }, commits: 1, ...change });
      return fake.run(argv, opts);
    };
    expect((await verifyPr(p.repo, p.number, run, withIdentity)).ok).toBe(false);
  }
});

test("a duplicate commit list cannot satisfy the expected count", async () => {
  const p = snapshot([commit([source, changedTest]), commit([changedTest], "test(ui): more", otherSha)]);
  const fake = recordedRunner(p);
  const run: Runner = async (argv, opts) => argv[4]!.includes("/pulls/99/commits?")
    ? json([{ sha }, { sha }]) : fake.run(argv, opts);
  expect((await verifyPr(p.repo, p.number, run, withIdentity)).ok).toBe(false);
});

test("a commit list for a different head cannot be certified", async () => {
  const p = { ...snapshot(), head: otherSha };
  const fake = recordedRunner(p);
  expect((await verifyPr(p.repo, p.number, fake.run, withIdentity)).ok).toBe(false);
});

test("the lane footer lists configured commit identities and the verify-pr rule", () => {
  const lane = { key: "demo-lane", title: "demo", thread: "none", brief: "/b.md", done: "merged acme/app#1", openedAt: "2026-01-01T00:00:00Z" };
  const text = footer(lane, "w1:p1", { "acme/app": IDENTITY });
  expect(text).toContain(`  - acme/app: git -c user.name='Example Dev' -c user.email='${IDENTITY.email}' commit ...`);
  expect(text).toContain(`run ${cliCommand()} verify-pr <owner/repo> <number>`);
  expect(footer(lane, "w1:p1")).not.toContain("Before committing");
});
