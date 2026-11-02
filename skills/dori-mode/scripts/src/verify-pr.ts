import type { Runner } from "./run.ts";

export type CommitIdentity = { readonly name: string; readonly email: string };
export type PrFile = { readonly filename: string; readonly status: string; readonly patch?: string; readonly previous_filename?: string };
export type PrCommit = {
  readonly sha: string;
  readonly commit: { readonly message: string; readonly author: CommitIdentity | null; readonly committer: CommitIdentity | null };
  readonly files: readonly PrFile[];
  readonly parents?: readonly { readonly sha: string }[];
};
export type PrSnapshot = {
  readonly repo: string;
  readonly number: number;
  readonly body: string | null;
  readonly head: string;
  readonly commits: readonly PrCommit[];
  readonly files: readonly PrFile[];
};
export type VerifyPrOptions = { readonly expectedIdentity?: CommitIdentity; readonly loopCount?: number; readonly cwd?: string };
export type VerifyPrResult = {
  readonly ok: boolean;
  readonly repo: string;
  readonly number: number;
  readonly head?: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly asyncUiTests: readonly string[];
  readonly loopCommand?: string;
};

// Fixture, helper, fake and mock directories never hold counted tests; a file with one of those names counts
// only when it is named as a test (helpers.test.ts), not when it merely sits in a test directory (test/fakes.ts).
const isTest = (path: string): boolean =>
  !/(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|helpers?|fakes?|mocks?)\//i.test(path)
  && (/(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path)
  || /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py))$/i.test(path)
  || (/(?:^|\/)(?:tests?|__tests__)\//i.test(path) && /\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path)
    && !/(?:^|\/)(?:(?:setup|conftest|test-utils)[./]|(?:fixtures?|helpers?|fakes?|mocks?)\.[^/]*$)/i.test(path)));

const isSource = (path: string): boolean =>
  !isTest(path) && !/(?:^|\/)(?:docs?|fixtures?|__fixtures__|__snapshots__)\//i.test(path)
  && /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|vue|svelte|py|go|rs|rb|sh|sql|c|cpp|h|java|kt|swift)$/i.test(path);

// A diff cannot prove a test is synchronous: include UI test candidates even
// when its async setup is outside the patch. This intentionally errs wide.
const isUiTest = (file: PrFile): boolean =>
  isTest(file.filename) && file.status !== "removed"
  && (/\.[jt]sx$/i.test(file.filename)
    || /(?:^|\/)(?:components?|features?|ui|e2e|browser|playwright)\//i.test(file.filename)
    || /\b(?:WebView|document|window|page\.(?:goto|locator)|render|screen\.|waitFor|userEvent|fireEvent)\b/.test(file.patch ?? ""));

const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
const failed = (repo: string, number: number, errors: readonly string[]): VerifyPrResult =>
  ({ ok: false, repo, number, errors, warnings: [], asyncUiTests: [] });

const optionErrors = (repo: string, number: number, options: VerifyPrOptions): string[] => {
  const errors: string[] = [];
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push("repository must be owner/repo");
  if (!Number.isSafeInteger(number) || number < 1) errors.push("PR number must be a positive integer");
  if (!Number.isSafeInteger(options.loopCount ?? 20) || (options.loopCount ?? 20) < 1) errors.push("loop count must be a positive integer");
  const identity = options.expectedIdentity;
  if (typeof identity?.name !== "string" || !identity.name.trim() || typeof identity.email !== "string" || !identity.email.trim()) errors.push(`missing expected author/committer identity for ${repo}; add it to repoIdentities in the config`);
  return errors;
};

export const checkPr = (snapshot: PrSnapshot, options: VerifyPrOptions = {}): VerifyPrResult => {
  const { repo, number } = snapshot;
  const errors = optionErrors(repo, number, options);
  const identity = options.expectedIdentity;
  if (errors.length || !identity) return failed(repo, number, errors);
  const warnings: string[] = [];
  const noTestReason = /^No test:[ \t]*(\S[^\r\n]*)$/m.exec(snapshot.body ?? "")?.[1]?.trim();
  if (!snapshot.commits.length) errors.push("PR has no commits to verify");
  let fixesSource = false;
  const changesTest = (file: PrFile): boolean =>
    ["added", "modified", "renamed", "copied", "changed"].includes(file.status) && isTest(file.filename);
  for (const c of snapshot.commits) {
    for (const role of ["author", "committer"] as const) {
      const actual = c.commit[role];
      if (typeof actual?.name !== "string" || !actual.name.trim() || typeof actual?.email !== "string" || !actual.email.trim()) errors.push(`${c.sha}: missing ${role} identity; expected ${identity.name} <${identity.email}>`);
      else if (actual.email.toLowerCase() === "noreply@github.com"
        ? !(role === "committer" && Array.isArray(c.parents) && c.parents.length > 1)
        : actual.email.toLowerCase() !== identity.email.toLowerCase()) {
        errors.push(`${c.sha}: wrong ${role} email ${actual.email}; expected ${identity.email}${role === "committer" ? " (or noreply@github.com for a merge commit)" : ""}`);
      }
    }
    if (/^fix(?:\([^)]+\))?!?:/.test(c.commit.message) && c.files.some((f) => isSource(f.filename) || (f.previous_filename !== undefined && isSource(f.previous_filename)))) {
      fixesSource = true;
      if (!c.files.some(changesTest)) warnings.push(`${c.sha}: fix commit changes source without its own added/changed test; coverage is evaluated across the PR`);
    }
  }
  if (fixesSource && !snapshot.files.some(changesTest)) {
    const message = "PR has source fix commits but no added/changed test";
    if (noTestReason) warnings.push(`${message}; No test: ${noTestReason}`);
    else errors.push(`${message}; add a test or an explicit nonempty "No test: <reason>" PR-body line`);
  }
  const candidates = new Set<string>();
  for (const c of snapshot.commits) for (const f of c.files) {
    if (f.status === "removed") candidates.delete(f.filename);
    if (f.previous_filename) candidates.delete(f.previous_filename);
    if (isUiTest(f)) candidates.add(f.filename);
  }
  const asyncUiTests = [...candidates].sort();
  const loopCount = options.loopCount ?? 20;
  const loopCommand = asyncUiTests.length
    ? `i=0; while [ "$i" -lt ${loopCount} ]; do bun --no-env-file test ${asyncUiTests.map((f) => quote(`./${f}`)).join(" ")} || exit $?; i=$((i + 1)); done`
    : undefined;
  return { ok: !errors.length, repo, number, head: snapshot.head, errors, warnings, asyncUiTests, loopCommand };
};

export const verifyPr = async (repo: string, number: number, run: Runner, options: VerifyPrOptions = {}): Promise<VerifyPrResult> => {
  const errors = optionErrors(repo, number, options);
  if (errors.length) return failed(repo, number, errors);
  const api = async (endpoint: string): Promise<unknown> => {
    const r = await run(["gh", "api", "--method", "GET", endpoint], { cwd: options.cwd, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`gh api ${endpoint}: exit ${r.code}: ${(r.err || r.out).trim()}`);
    try { return JSON.parse(r.out); } catch { throw new Error(`gh api ${endpoint}: invalid JSON`); }
  };
  try {
    const root = `repos/${repo}`;
    const metadata = (value: unknown): { body: string | null; head: { sha: string }; commits: number } => {
      const p = value as { body?: unknown; head?: { sha?: unknown }; commits?: unknown } | null;
      if (!p || (p.body !== null && typeof p.body !== "string") || typeof p.head?.sha !== "string" || !/^[a-f0-9]{40}$/i.test(p.head.sha)
        || !Number.isSafeInteger(p.commits) || Number(p.commits) < 1) throw new Error("incomplete PR metadata");
      return p as { body: string | null; head: { sha: string }; commits: number };
    };
    const before = metadata(await api(`${root}/pulls/${number}`));
    const listed: { sha: string }[] = [];
    for (let page = 1; ; page++) {
      const rows = await api(`${root}/pulls/${number}/commits?per_page=100&page=${page}`);
      if (!Array.isArray(rows) || !rows.every((c) => c && typeof c.sha === "string" && /^[a-f0-9]{40}$/i.test(c.sha))) throw new Error("incomplete PR commit list");
      listed.push(...rows);
      // More commits than the PR reports fails the count check below instead of paging forever.
      if (rows.length < 100 || listed.length > before.commits) break;
    }
    if (listed.length !== before.commits || new Set(listed.map((c) => c.sha)).size !== listed.length) throw new Error(`incomplete PR commit list: received ${listed.length}, expected ${before.commits}`);
    if (listed.at(-1)?.sha !== before.head.sha) throw new Error("PR commit list does not end at the current head");
    const commits: PrCommit[] = [];
    for (const listedCommit of listed) {
      const files: PrFile[] = [];
      let commit: PrCommit | undefined;
      for (let page = 1; ; page++) {
        const c = await api(`${root}/commits/${listedCommit.sha}?per_page=100&page=${page}`) as PrCommit | null;
        if (!c || c.sha !== listedCommit.sha || typeof c.commit?.message !== "string" || !("author" in c.commit) || !("committer" in c.commit)
          || !Array.isArray(c.files) || !c.files.every((f) => typeof f.filename === "string" && typeof f.status === "string" && (f.patch === undefined || typeof f.patch === "string") && (f.previous_filename === undefined || typeof f.previous_filename === "string"))) throw new Error(`incomplete commit data for ${listedCommit.sha}`);
        commit = c;
        files.push(...c.files);
        if (c.files.length < 100) break;
        if (page >= 30) throw new Error(`${listedCommit.sha}: cannot verify beyond GitHub's 3000-file commit limit`);
      }
      commits.push({ ...commit, files });
    }
    const files: PrFile[] = [];
    for (let page = 1; ; page++) {
      const rows = await api(`${root}/pulls/${number}/files?per_page=100&page=${page}`);
      if (!Array.isArray(rows) || !rows.every((f) => f && typeof f.filename === "string" && typeof f.status === "string")) throw new Error("incomplete PR file list");
      files.push(...rows);
      if (rows.length < 100) break;
      if (page >= 30) throw new Error("cannot verify beyond GitHub's 3000-file PR limit");
    }
    const after = metadata(await api(`${root}/pulls/${number}`));
    if (before.head.sha !== after.head.sha || before.body !== after.body || before.commits !== after.commits) throw new Error("PR changed during verification; run verify-pr again");
    return checkPr({ repo, number, body: before.body, head: before.head.sha, commits, files }, options);
  } catch (e) {
    return failed(repo, number, [e instanceof Error ? e.message : String(e)]);
  }
};

export const formatVerifyPr = (result: VerifyPrResult): string => [
  `${result.ok ? "PASS" : "FAIL"} ${result.repo}#${result.number}${result.head ? ` at ${result.head}` : ""}`,
  ...result.errors.map((error) => `- ${error}`),
  ...result.warnings.map((warning) => `WARNING ${warning}`),
  ...(result.asyncUiTests.length ? ["Async UI loop candidates (conservative; not executed):", ...result.asyncUiTests.map((file) => `- ${file}`), `Run from the repository checkout at ${result.head}:`, result.loopCommand!] : ["No changed async UI test candidates found; no loop executed."]),
].join("\n");
