import { fileURLToPath } from "node:url";

import { type DoriConfig, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { readScreen, statusLookup } from "./panes.ts";
import { LANE_KEY, type Lane } from "./registry.ts";
import { iso } from "./run.ts";
import { Reports } from "./reports.ts";
import { doneSyntaxErrors } from "./signals.ts";
import type { BudgetLimits } from "./supervision.ts";
import { Lessons, renderLessons } from "./lessons.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
};

export class LaunchError extends Error {}

const STARTUP_FAILURE = /Cannot find module|All fallback models failed|No API key|model_not_available|usage limit|rate limit|quota|Session crashed|unknown provider/i;
// `goalMarker` is the agent's status text while a goal is active (omo: `Pursuing goal`). A lane that starts but never
// sets its goal stops after its first turn, so a ready status alone is not a good start. The status line shares its row
// with other extensions' status text, so the marker is matched in the footer (the last lines), never in agent output
// that quotes it. An empty marker turns the check off.
const GOAL_CHECKS = 6;
const goalShown = (screen: string, marker: string): boolean =>
  screen.split("\n").filter((s) => s.trim()).slice(-3).join("\n").includes(marker);

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  for (const [name, value] of Object.entries(input.budget ?? {})) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new LaunchError(`invalid ${name} ceiling`);
  }
};

// The footer names this CLI by path: a bare `dori` can resolve to the root harness, whose `report` accepts unknown
// flags and writes no journal, so a jsonl-v1 lane would read NO-REPORT for its whole life.
export const shellQuote = (s: string): string => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
export const cliCommand = (path: string = fileURLToPath(new URL("./cli.ts", import.meta.url))): string => `bun ${shellQuote(path)}`;
const CLI = cliCommand();

export const footer = (lane: Lane, leadPane: string, identities: DoriConfig["repoIdentities"] = {}): string => [
  "",
  "## Lane footer (written by dori launch)",
  `- Key: ${lane.key}. Work thread: ${lane.thread}.`,
  `- Done = ${lane.done}. The lane closes only when every signal reads back live.`,
  `- Persist each milestone, blocker, question, halt and completion with ${CLI} report ${lane.key} --kind milestone|blocker|question|halted|done --text "what, with evidence links". It appends reports.jsonl and prints the human [REPORT] line; send that line to pane ${leadPane || "(lead pane)"} as an argv array, never a shell string.`,
  ...(Object.keys(identities).length ? [
    "- Before committing, set the repository's identity below for that command only; never change the global Git identity. For a repository not listed, ask the lead for its identity before the first commit.",
    ...Object.entries(identities).map(([repo, identity]) => `  - ${repo}: git -c user.name=${quoteForPane(identity.name)} -c user.email=${quoteForPane(identity.email)} commit ...`),
  ] : []),
  `- Before claiming PR work done, run ${CLI} verify-pr <owner/repo> <number>. A PR with source fix commits must change a test or carry a "No test: <reason>" line in its body; a fix commit without its own test is a warning. Run the printed UI test loop at the reported head before calling those tests stable.`,
  `- After each completed step: ${CLI} checkpoint ${lane.key} --step <unique-step> --result <result> --evidence <path-or-URL> [--remote-effect <completed-push/merge/deploy-receipt>] (one flag per receipt).`,
  `- On resume, run ${CLI} checkpoints ${lane.key} before doing work. Never repeat a recorded remote side effect. If a crash may have happened between the remote action and checkpoint, read the live remote receipt first and use the service's idempotency key; a local journal cannot make that remote action atomic.`,
  `- Supervision ceilings: ${JSON.stringify(lane.budget ?? {})}. A breach marks blocked and alerts; it never kills the agent. Report a blocker and wait for the lead's decision rather than overriding the ceiling.`,
  `- When done: ${CLI} claim-done ${lane.key} --evidence "<merge SHA, closed issue, version>". See references/done-protocol.md.`,
  "",
].join("\n");

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const lane: Lane = { key: input.key, title: input.title, thread: input.thread ?? "none", pane: input.pane, brief: input.brief, done: input.done, cwd: input.cwd ?? deps.config.defaultCwd, openedAt: iso(deps.clock) };
  await deps.registry.write(lane);
  return lane;
};

export const prepareLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<{ readonly lane: Lane; readonly preamble: string; readonly warnings: string[] }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const draft: Lane = {
    key: input.key, title: input.title, thread: input.thread ?? "none", brief: input.brief, done: input.done, cwd, model,
    openedAt: iso(deps.clock), reportProtocol: "jsonl-v1",
    budget: {
      ...deps.config.supervision.defaults, ...deps.config.supervision.lanes?.[input.key],
      // An undefined field is absent, so it keeps the configured ceiling; only null turns one off.
      ...Object.fromEntries(Object.entries(input.budget ?? {}).filter(([, value]) => value !== undefined)),
    },
    activityPaths: input.activityPaths ?? [],
  };
  // A damaged journal line is a warning: it must not keep a lane from starting or hide the lessons around it.
  const { lessons, problems } = new Lessons(deps.config.stateDir).forRepo(cwd);
  return { lane: draft, warnings: problems.map((problem) => `LESSON_WARNING ${problem}`), preamble: `${renderLessons(lessons)}${(await briefFile.text()).replace(/\s*$/, "")}\n${footer(draft, deps.config.leadPane, deps.config.repoIdentities)}` };
};

export const launchLane = async (deps: FlowDeps, input: LaunchInput): Promise<{ readonly lane: Lane; readonly startup: string; readonly warnings: string[] }> => {
  const prepared = await prepareLaunch(deps, input);
  return { ...(await startLane(deps, input, prepared.lane, prepared.preamble)), warnings: prepared.warnings };
};

const startLane = async (deps: FlowDeps, input: LaunchInput, draft: Lane, preamble: string): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  await Bun.write(input.brief, preamble);
  const created = await deps.run(["herdr", "tab", "create", ...(deps.config.laneWorkspace ? ["--workspace", deps.config.laneWorkspace] : []), "--cwd", cwd, "--label", input.key, "--no-focus"]);
  if (created.code !== 0) throw new LaunchError(`herdr tab create failed: ${created.err || created.out}`);
  const made = (JSON.parse(created.out) as { result: { root_pane: { pane_id: string; tab_id?: string }; tab_id?: string } }).result;
  const pane = made.root_pane.pane_id;
  const tab = made.tab_id ?? made.root_pane.tab_id;
  // Registered before the agent starts: dori report refuses an unknown key, so a fast lane's first report would be lost.
  const lane: Lane = { ...draft, pane, ...(tab ? { tab } : {}) };
  await deps.registry.write(lane);
  // The launch is an activity record, not a report: it starts the journal (so the screen is watched for a stall) but is
  // never posted to the thread as if the agent had reported.
  new Reports(deps.config.stateDir).append({ type: "activity", key: lane.key, at: iso(deps.clock), state: "running", text: `lane launched in ${pane}` });
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  await deps.run(["herdr", "pane", "run", pane, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" ")]);
  await deps.clock.sleep(20_000);
  const screen = await readScreen(deps.run, pane, 40);
  const bad = STARTUP_FAILURE.exec(screen);
  if (bad) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${bad[0]}` };
  const { status, error } = await statusLookup(deps.run, pane);
  if (status === "idle" || status === "working") {
    const marker = deps.config.goalMarker;
    let shown = screen;
    for (let check = 0; marker && !goalShown(shown, marker); check++) {
      if (check === GOAL_CHECKS) return { lane, startup: `STARTUP_NO_GOAL ${input.key} ${pane}: the agent is running but shows no goal after ${20 + GOAL_CHECKS * 10} s; last lines: ${lastLines(shown)}` };
      await deps.clock.sleep(10_000);
      shown = await readScreen(deps.run, pane, 40);
      // The goal is only good news while the agent is still running: re-check the status on every re-read.
      const again = await statusLookup(deps.run, pane);
      if (again.status !== "idle" && again.status !== "working") {
        const lost = again.error ? `status lookup failed: ${again.error}` : `agent status became ${again.status ?? "none"}`;
        return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${lost} while waiting for its goal; last lines: ${lastLines(shown)}` };
      }
      // A late failure stops the agent. A working agent's own output may quote these phrases (a file or log it reads),
      // so only an idle agent with no goal is checked for one.
      const failed = again.status === "idle" && !goalShown(shown, marker) ? STARTUP_FAILURE.exec(shown) : null;
      if (failed) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${failed[0]}` };
    }
    return { lane, startup: `STARTUP_OK ${input.key} ${pane}` };
  }
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
};

const lastLines = (screen: string): string =>
  screen.split("\n").map((s) => s.trim()).filter(Boolean).slice(-3).join(" / ").replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)").slice(0, 240) || "(blank)";

export const quoteForPane = (arg: string): string => (/^[\w./:@=-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
