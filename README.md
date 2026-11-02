<p align="center">
  <img src="skills/dori-mode/assets/dori-avatar.png" alt="Dori" width="120">
</p>

# dori-superagent

A proactive multi-session coding-agent harness in about 1,600 lines of TypeScript, running on [herdr](https://github.com/herdrdev/herdr) and [omo](https://github.com/code-yeongyu/oh-my-openagent).

English | [한국어](README.ko.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

One lead session talks to you. Each task runs as a lane: its own omo session in its own herdr tab, started from a written brief and finished with a READY that must carry evidence. A duty loop nudges lanes that go quiet, escalates to the lead, and holds messages for busy panes until they can read them. Merges pass through a gate that requires a CLEAR review receipt at the exact head plus green checks.

## Why this exists

DeepSeek published [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) (first commit 2026-10-31) and, about a day later, the article "Exploring Super-agent Design: Towards a More Autonomous Agent System". Their design has a long-lived Router session that only talks to humans and dispatches work, isolated Worker sessions with one per ticket, event triggers batched per turn, and a watchdog. Their README calls it a research prototype, and its stated philosophy is to "take as little human attention as possible, and give as much value as possible".

We have been running the same shape for about six months, in public:

- 2026-04-18: team mode lands in omo, several agent sessions in terminal panes with a worktree each ([f1268c0](https://github.com/code-yeongyu/oh-my-openagent/commit/f1268c0), [e303fee](https://github.com/code-yeongyu/oh-my-openagent/commit/e303fee)).
- 2026-05-06: the Dori name enters the omo README ([#3807](https://github.com/code-yeongyu/oh-my-openagent/pull/3807)).
- 2026-10-07: this repository publishes Dori mode, as `omo-dori-mode-experimental` ([ce53e4d](https://github.com/sisyphuslabs/dori-superagent/commit/ce53e4d)): one agent hands each job to its own agent session in a herdr tab and closes it only after the work is done. The git history is public.
- 2026-10-31: DeepSeek's prototype gets its first commit.
- Around 2026-11-01: DeepSeek's article.

It is how we work every day. omo has 70k+ stars. Over the 31 days from 2026-10-03 to 2026-11-02, the [author's GitHub contribution calendar](https://github.com/code-yeongyu) shows 38,656 contributions: about 1,250 a day on average, with peaks of 2,227 on 2026-10-16 and 2,001 on 2026-10-29. That is up to ~2,000 contributions a day, produced with the full version of this setup.

The harness at the root of this repo is the minimal version: the part that runs on herdr and omo alone, with nothing else attached.

## Same structure, same philosophy

Put DeepSeek's prototype docs next to Dori and the concepts line up one for one, in the structure of the pipeline and in the rules of their [philosophy doc](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md).

![Dori vs DeepSeek](docs/dori-vs-deepseek.en.png)

### Structure

| DeepSeek dsh-superagent | Dori |
|---|---|
| Source: GitHub, Feishu | Dori lives in chat: Slack, Discord, Telegram |
| Trigger, then Eval, then Ticket | One task asked in chat becomes one ticket |
| Executor session per ticket: one session, one work directory | One coding-agent session per task, run on omo, many in parallel |
| Channel: answers in the original conversation, with a PR for example | Reports in the same channel, one status message per task, edited in place |
| Panel: shows only what needs a person | The ticket board and Notion stay current on their own |

### Philosophy

| DeepSeek dsh-superagent | Dori |
|---|---|
| Least human attention, most value | Short messages, no emojis, a ping only after the merge |
| Acts only when asked or when a written team rule allows it | People set direction and bring new ideas; Dori starts no work nobody asked for |
| Speaks only when a person must act, one question at a time | A decision comes with options, its own recommendation and one picture |
| Reports honestly, never works around a block | No "done" without proof; checked against a real case, and the report is the merged result |

The Dori column is our production Dori and Dori mode (`skills/dori-mode`). The harness at the root of this repo implements its lane, inbox, duty and merge-gate part on herdr and omo.

## Architecture

![architecture](docs/architecture.png)

Three roles, each an omo session in a herdr pane. herdr provides the workspaces, tabs and panes, recognises omo in a pane as an agent, and reports its state (idle, working, blocked, done) over its CLI. dori reads that state before it does anything to a pane.

The lead is the only session that talks to you. It turns a request into a brief, opens a lane with `dori start`, reads what lanes send back, and merges.

A lane is one omo session in its own herdr tab, started with one brief and the lane rules appended to it (`prompts/lane-footer.md`). It reports milestones with `dori report` and finishes with `dori ready`, which refuses to go out without an evidence link.

The duty loop is `dori duty --interval 60`, a plain process in a pane next to a duty omo session. Each tick it flushes queued messages into panes that have gone idle, nudges lanes that have been silent, escalates to the lead, and marks a lane whose pane vanished as lost.

State is JSON on disk under `~/.dori` (or `$DORI_HOME`): `lanes/`, `inbox/`, `briefs/`, `receipts/`, plus `backlog/` and `loop/` for the hourly loop. Besides the agent sessions, the only long-running processes the harness adds are the duty loop and the hourly loop, and the only runtime dependency is Bun.

![lane lifecycle](docs/lane-flow.png)

`dori start <key> --brief FILE` writes the brief plus the lane rules to `~/.dori/briefs/<key>.md`, opens a tab, runs `omo 'Read your brief at <path> and execute it. Your lane key is <key>.'`, records the lane as `working`, and sends the lead `[START <key>]`. From there the lane reports (`[REPORT <key>]`, or `[REPORT <key> WAITING]` when it is blocked outside its own pane) and ends with `[READY <key>]` plus its evidence links. The lead checks the evidence, runs `dori review` and `dori merge` when there is a PR, and closes the lane with `dori done <key>`. A lane that stays idle gets a nudge at 10 and 20 minutes and is escalated to the lead at 40 (`[ESCALATE <key>]`). A lane whose pane disappears before READY is reported as `[LOST <key>]`.

## Mapping to DeepSeek's super-agent

| DeepSeek super-agent | dori | In this repo |
|---|---|---|
| Router session: talks to humans, dispatches | LEAD session: the only one that talks to the human; opens lanes, merges | `prompts/lead.md`, `up()` in `src/cli.ts` |
| Worker session, one per ticket | LANE: one omo session per task in its own herdr tab, with its own brief | `startLane()` in `src/harness.ts`, `prompts/lane-footer.md` |
| Ticket + Mandate | brief file + lane rules footer, and a READY that must carry evidence | `~/.dori/briefs/<key>.md`, `ready()` in `src/harness.ts` |
| Trigger batching: events batched per turn | pane inbox: messages to a busy pane queue and arrive as one batch when it goes idle | `send()`, `flushInbox()` in `src/harness.ts`; `inbox/` in `src/store.ts` |
| Watchdog | DUTY loop: flushes inboxes, nudges at 10/20 minutes, escalates at 40, detects lost panes | `dutyTick()` in `src/harness.ts`, `prompts/duty.md`, `prompts/nudge.md` |
| Admission matrix, `maxWorkers` (default 3) | hourly loop budget: at most `--max-lanes` (default 3) open lanes, `--max-starts` (default 2) per run, no starts on a loaded host | `loopTick()` in `src/loop.ts` |
| not in the prototype | gated merge: CLEAR review receipt at the exact head SHA plus green checks; an empty check list is never green | `review()`, `mergeGate()` in `src/harness.ts`, `prompts/review.md`, `receipts/` in `src/store.ts` |
| not in the prototype | one-voice rule: lanes and duty never talk to the human | `prompts/lead.md`, `prompts/duty.md`, `prompts/lane-footer.md` |
| not in the prototype | full-text answer ledger: each lane's final answer, evidence links and log kept on disk | `Lane.final`, `Lane.log` in `src/store.ts` |

## Quick start

You need Bun 1.3 or newer, herdr, omo, and the GitHub CLI `gh` (used for PR head SHAs, checks and the merge).

```sh
git clone https://github.com/sisyphuslabs/dori-superagent
cd dori-superagent
bun install
bun link   # puts `dori` on your PATH; or write `bun src/cli.ts` wherever `dori` appears below
```

Start herdr, then from a shell:

```sh
dori up
# UP lead=w1:p1 duty=w1:p2 loop=w1:p3 hourly=w1:p4 home=~/.dori
```

That opens a herdr workspace named `dori` with a lead pane (omo with `prompts/lead.md` appended to its system prompt), a duty pane (omo with `prompts/duty.md`), the duty loop below it, and the hourly loop below that. Talk to the lead pane. It writes a brief (goal, inputs, deliverable, stop condition, constraints; see [`examples/brief.md`](examples/brief.md)) and opens lanes itself, and you can do the same from the shell:

```sh
dori start fix-flaky-login --brief examples/brief.md
# STARTED fix-flaky-login pane=w1:p5 brief=~/.dori/briefs/fix-flaky-login.md
dori status
# lead=w1:p1 duty=w1:p2 home=~/.dori
# fix-flaky-login          working  w1:p5    active 0m ago  start: examples/brief.md
```

A lane key matches `^[a-z][a-z0-9-]{1,40}$`, and a key that is already open is refused.

Inside a lane, omo reports and finishes with the commands the lane rules hand it:

```sh
dori report fix-flaky-login --text 'reproduced: 1 failure in 20 runs, shared session fixture'
dori report fix-flaky-login --status waiting --text 'WAITING: checks on owner/repo#12'
dori ready fix-flaky-login --text 'root cause fixed in owner/repo#12, checks green' --evidence https://github.com/owner/repo/pull/12
```

The lead, on `[READY fix-flaky-login]`:

```sh
dori review owner/repo#12            # fresh omo reviewer pinned to the head SHA; writes a receipt; exit 0 on CLEAR
dori merge owner/repo#12 --dry-run   # MERGE_OK ... (dry run), or MERGE_REFUSED <why> with exit 2
dori merge owner/repo#12             # gh pr merge --squash --match-head-commit <sha>
dori done fix-flaky-login            # closes the lane's pane; only a READY lane can be closed
```

`dori send <lead|duty|key|pane> --text '...'` delivers a message to a pane, or queues it when the pane is busy. `dori role <lead|duty> [PANE]` registers a pane by hand when you did not use `dori up`. `--text` can be left off to read the message from stdin. The commands the agents see are rendered with the full path to `src/cli.ts` and `DORI_HOME` set, so `dori` does not need to be on their PATH. Environment: `DORI_HOME` (state directory, default `~/.dori`), `DORI_AGENT_CMD` (default `omo`), `DORI_HERDR_SESSION` (a named herdr session), `DORI_CMD` (how the agents are told to call dori).

## What the harness enforces

One voice. The lead is the only session that talks to you (`prompts/lead.md`). The lane rules say every fact meant for the human goes to the lead (`prompts/lane-footer.md`, rule 3), and the duty session never merges and never talks to the human (`prompts/duty.md`). Everything a lane does reaches the lead pane as a prompt: `[START]`, `[REPORT]`, `[READY]`, `[LOST]`, `[ESCALATE]`.

READY needs evidence. `dori ready` refuses without at least one `--evidence` link and without final answer text (`ready()` in `src/harness.ts`). The text and links are stored on the lane record as `final`, and `dori done` refuses any lane that is not `ready`, so no lane closes without a recorded answer.

Busy panes are never interrupted. `dori send` asks herdr for the pane's agent state first. `idle`, `done`, or a plain shell get the message now; anything else has it queued in `~/.dori/inbox/`, and the command prints `QUEUED`. The duty loop delivers the queue when the pane goes idle, as a single message that starts with "N messages arrived while you were busy" (`send()` and `flushInbox()` in `src/harness.ts`). `dori done` waits the same way: it refuses to close a pane that herdr reports as working or blocked.

Nudges at 10, 20 and 40 minutes. `NUDGE_MINUTES = [10, 20, 40]` in `src/harness.ts`. A lane that has not reported for 10 minutes, and whose pane is not working, gets `prompts/nudge.md` in its pane. At 20 it gets it again. At 40 the duty loop stops nudging and sends the lead `[ESCALATE <key>]`. A `working` pane resets the idle clock, a lane that reported `--status waiting` or whose pane is `blocked` is left alone, any new report resets the nudge count, and a pane that disappears is reported as `[LOST <key>]`.

Merge needs a CLEAR receipt at the exact head and green checks. `dori merge` reads the PR's head SHA with `gh`, then requires a receipt for that SHA in `~/.dori/receipts/` with verdict `CLEAR`. Only `dori review` writes receipts. It runs a fresh non-interactive omo (`omo -p --no-session`, optionally `--model`) on `prompts/review.md` pinned to that SHA, and when the reviewer prints no `VERDICT:` line, no receipt is written. Then `gh pr checks` must return at least one check, every check must be `pass` or `skipping`, and at least one must be `pass`. An empty check list is refused with "an empty check list is never green". The merge itself is `gh pr merge --squash --match-head-commit <sha>`. A push after the review changes the head SHA, so the receipt no longer matches and the merge is refused (`review()` and `mergeGate()` in `src/harness.ts`).

## Hourly loop

`dori up` also starts `dori loop` in a fourth pane. Once an hour it checks the harness against reality and starts the next piece of work that needs nobody's decision, so the lead does not have to remember what comes next. The full design is in [`docs/hourly-loop.md`](docs/hourly-loop.md).

Work waits in a backlog under `~/.dori/backlog/`, one brief per item. The lead adds items, or you import open GitHub issues that carry a label:

```sh
dori backlog add search-index --brief briefs/search.md --priority 2
dori backlog add new-billing --brief briefs/billing.md --decision 'charge per seat or per workspace?'
dori backlog import owner/repo --label dori     # label p1..p9 sets the priority, needs-decision marks a question
dori backlog list
```

A run first checks its gate: it does nothing while the loop is stopped, while another loop holds the lock, or when the last run was less than an interval ago (one hour by default; `--force` skips this check). A run that passes the gate does five things, in order:

1. Sync. An item whose lane is done, or whose READY PR has merged, becomes done. An item whose lane was lost goes back to the queue, and after two losses it turns into a question. An imported item whose issue was closed is dropped.
2. Missed-work audit. A lane with no report for 3 hours, a READY lane nobody closed for 2 hours, a lane whose pane vanished.
3. Pull. It starts the next open items with no open question, by priority, then age (an item whose start fails twice becomes a question, so it never blocks the rest), within `--max-lanes` (default 3) open lanes and `--max-starts` (default 2) per run. Nothing starts while the 1-minute load is above the core count (or `--max-load`) or less than 10% of memory is available (on macOS the kernel's available-memory level, since free pages alone run near zero there).
4. Ask. Each open question reaches the lead once as `[DECIDE <id>]`, with one reminder after 6 hours. The lead asks you, then records the answer with `dori backlog decide <id> --text '...'` (the answer is appended to the item's brief) or `dori backlog drop <id>`.
5. Report. One `[LOOP ...]` message goes to the lead with open lanes against the limit, backlog counts, host load and free memory, and each finding. Every run that passes the gate is also kept in `~/.dori/loop/runs/`.

Besides its own state (backlog items, run records, the lock), the loop only opens lanes and sends messages. It never merges, never pushes, never closes a pane and never edits an open lane's record (retrying a lost item starts a fresh lane under the same key); its `gh` calls only read. `dori loop stop --text 'why'` is the kill switch: until `dori loop resume`, every run does nothing. A lock and a last-run stamp keep two loops from running the same hour twice, so `dori loop --once` from cron is safe next to the pane. `dori loop status` prints the last run.

## Dori mode (`skills/dori-mode`)

Dori mode is the messenger-facing half, published in this repository on 2026-10-07. It turns one coding-agent session into an always-on agent you talk to over a messenger. That session hands each job to its own agent session in a herdr tab, keeps a registry of every session it started, and closes one only after the work is proven done: a merged PR, a closed issue, a published version, or a check it can run itself. It ships as a skill (`skills/dori-mode/SKILL.md` plus `references/`) and its own Bun + TypeScript CLI, also called `dori`.

```sh
curl -fsSL https://raw.githubusercontent.com/sisyphuslabs/dori-superagent/main/install.sh | bash
```

That clones this repo to `~/.dori/src`, links the skill into `~/.agents/skills/dori-mode`, puts Dori mode's `dori` on your PATH with `bun link`, and copies an example config to `~/.dori/config.json`. Commands, configuration, routing and the done protocol are in [`skills/dori-mode/SKILL.md`](skills/dori-mode/SKILL.md) and its [`references/`](skills/dori-mode/references/).

Both the harness and Dori mode ship a command named `dori`. Install one of them per machine, or run the harness as `bun src/cli.ts` and leave `dori` to Dori mode. The harness's own prompts call it by the full path to `src/cli.ts`, so the agents it starts never depend on which `dori` is on PATH.

## What this is not

A minimal experiment. The harness is about 1,600 lines of TypeScript on Bun with zero runtime dependencies, and it is not our production stack. Left out on purpose: the cross-machine mesh, heavy-slot scheduling, the chat and ticket-tracker bridges, and receipts for whole test suites. What is here is the part that runs on herdr and omo alone: roles, lanes, the inbox, the duty loop, the hourly loop and backlog, and the review and merge gate. Dori mode in `skills/dori-mode` is a separate CLI with its own messenger pieces, host guard and heavy-slot runner; the harness imports nothing from it.

## Telemetry

dori sends anonymous usage counts the same way omo does: OTLP/HTTP JSON logs to the omo collector at `https://t.omo.dev`. The identity is a random install id kept in `~/.dori/telemetry.json`, and only its sha256 is sent. On the first send the collector mints a per-install ingest key from that hash (`POST /v1/register`); the key is cached in `~/.dori/telemetry.json` and minted again after the collector answers 401. No shared key ships in the code. The first run prints a one-line notice. Turn it off with `DORI_TELEMETRY=0` (`DO_NOT_TRACK=1` also works), and point it at another collector with `DORI_TELEMETRY_ENDPOINT`.

| event | when | fields |
|---|---|---|
| `dori.installed` | first run | none |
| `dori.daily_active` | once per UTC day, on any dori command | `day_utc` |
| `dori.lane_started` | `dori start` | `open_lanes` |
| `dori.lane_ready` | `dori ready` | `evidence_count`, `lane_minutes` |
| `dori.review_completed` | `dori review` | `verdict`: `CLEAR` or `BLOCK` |
| `dori.merge_decided` | `dori merge` without `--dry-run` | `outcome`: `merged`, `no_receipt`, `review_block`, `no_checks`, `checks_red`, `checks_all_skipped` |
| `dori.duty_summary` | at most once an hour, from the duty loop | `ticks`, `flushed`, `nudges`, `escalations`, `lost` |

`dori.daily_active` is what gives the daily, weekly and monthly active counts. Actives are counted per install, so the rare second copy from two runs starting at the same moment does not change them. Every record also carries the resource fields: service name and version, the install hash, a CI flag, the OS type (`darwin`, `linux` or `windows`; other systems send nothing) and version, and the CPU architecture. Never sent: paths, repo names, PR numbers, lane keys, briefs, messages or any other text. Sending runs in the background with a 2 second timeout per request; a command waits at most 2 seconds for it before exiting, and a telemetry failure never fails a command.

## Tests

`bun test ./test/` at the repo root runs the harness's 40 tests and calls no model. Plain `bun test` would also pick up the Dori mode tests.

Eight harness unit tests (`test/harness.test.ts`) run against a fake herdr (`test/fake.ts`): a recorder that stands in for the `herdr` and `gh` binaries, holds panes with a settable agent status, and has a clock the tests move. They cover lane start and READY, the queue-and-batch behaviour of a busy lead, refused unknown targets, nudges at 10 and 20 with escalation at 40 and WAITING lanes left alone, the working and lost states, every branch of the merge gate (no receipt, BLOCK, empty check list, a red check, all checks skipped, CLEAR plus green), and a reviewer with no VERDICT line.

Nineteen more unit tests (`test/loop.test.ts`) run the hourly loop on the same fake: backlog add, decide, drop and import; start order and budget; holds for full lanes, a busy host and open questions; sync of done, lost and merged lanes; the missed-work audit; one ask and one reminder per question; the kill switch, a live, dead or corrupt lock, a lock lost mid-run, and a moved lock that cannot be put back; failed lane starts, an item whose start keeps failing until it becomes a question, and a lane that opened but could not tell the lead; the wait between runs; ids that try to leave the backlog directory; a vanished lane record; and two runs in the same millisecond. Two of them check that a run never sends a pane close, a merge or a push, and the audit test also checks that lane records stay byte-identical.

Eleven telemetry unit tests (`test/telemetry.test.ts`) cover the opt-out; the notice and `dori.daily_active` once per day; the per-install key minted once, cached, and minted again after a 401; the payload matching the registered schema (scope name and version, allowed resource keys only, counts only); records the collector refuses inside a 200 reply (`partialSuccess.rejectedLogRecords`) being counted; the hourly duty summary; an offline first run that keeps `dori.installed` and `dori.daily_active` pending until a send succeeds; a private (0600) state file, and a corrupt one that never throws; calls that return at once, with a flush that gives up at its deadline; two first runs racing on one home ending up with one install id; and an unreachable collector or a refused registration that never throws and sends no logs.

Two end-to-end tests (`test/e2e.test.ts`). The first starts a real herdr server in an isolated named session, creates a workspace, registers a lead pane, and starts a lane whose agent is `test/fixtures/fake-agent.sh` in place of omo. The script reads its brief, calls `dori report` and `dori ready`, and the test checks that `[START]`, `[REPORT]` and `[READY]` arrive in the lead pane and that `dori done` closes the lane. The second adds a backlog item, runs `dori loop --once`, and checks that the lane it starts reaches READY, that `[LOOP ...]` reaches the lead pane, and that `dori loop stop` makes the next run do nothing. Both are skipped when `herdr` is not on PATH and run with `DORI_TELEMETRY=0`. `bun run typecheck` runs `tsc --noEmit`.

Dori mode has its own 193 tests, against fake herdr, git and gh:

```sh
cd skills/dori-mode/scripts && bun install && bun test
```

## License

MIT, see [LICENSE](LICENSE).
