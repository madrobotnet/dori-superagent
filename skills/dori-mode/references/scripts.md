# Scripts

`scripts/` is a bun + TypeScript package with one CLI, `dori`. Every external command runs as an argv array; nothing builds a shell string.

## Install and test

```sh
cd skills/dori-mode/scripts
bun install          # dev dependencies only (types, tsc)
bun link             # puts `dori` on your PATH
bun test             # behavior tests with fake herdr/git/gh; nothing real is touched
bunx tsc --noEmit    # typecheck
```

Needs: bun 1.3+, herdr, git, and the GitHub CLI (`gh`) for `merged`/`closed` signals (npm for `published`). The `command`, `file` and `url` signals need nothing extra. The full list of signal kinds is in `sessions.md`. The host guard reads `sysctl`, `memory_pressure` and `df` on macOS; on Linux it reads `/proc/loadavg` and `df`, and memory and swap read as unknown.

## Configuration

`~/.dori/config.json` (or the path in `DORI_CONFIG`). Every field is optional; see `config.example.json`. `DORI_STATE_DIR` and `DORI_LEAD_PANE` override the file.

| Field | Default | Used by |
|---|---|---|
| `stateDir` | `~/.dori/state` | registry, heavy slots |
| `laneWorkspace` | current workspace | `launch` |
| `workspaces` | all | `sync`, `dead-panes` |
| `ignorePanes`, `leadPane` | none | panes the sweeps skip; `leadPane` is also where lanes report |
| `defaultCwd` | home | where lanes start, and the repo whose worktrees they own |
| `agentCommand`, `defaultModel`, `launchKeywords` | `omo --model {model} {prompt}` | `launch` |
| `sessionsDir` | `~/.omo/agent/sessions` | session-id lookup |
| `nudgeAfterMin`, `postAfterMin` | 15, 20 | `freshness` |
| `closeAfterMin` | 5 | `watch` |
| `heavySlots`, `heavyMaxLoad` | 1, 80 | `heavy` |
| `deadPanePatterns` | `has stopped`, `no suitable jobs` | `dead-panes` |
| `guard` | load 150/80, 20% memory, 50 GB disk, 20 panes | `guard` |
| `hooks.threadReply`, `hooks.threadDone` | none | `freshness`, `close` |
| `hooks.transcribe` | none | `transcribe` (argv with `{file}`, prints the text) |
| `supervision` | no ceilings by default (set wallMinutes, tokens or costUsd to enable); hung after 20 min | `freshness`, `launch`, `close` (see Supervision below) |
| `repoIdentities` | none | `verify-pr`, `launch` footer: expected Git name and email per `owner/repo` (keys match without case) |

Hooks are argv templates for your messenger CLI. `{thread}`, `{text}` and `{key}` are filled into each argument separately, so the text stays one argument whatever it contains.

## Library modules

The CLI is a thin layer over typed modules you can import in your own scripts:

| Module | What it gives you |
|---|---|
| `src/messenger/slack.ts` | `Slack`: post, edit, thread replies, file upload (upload URL + complete), presence; 429 backoff |
| `src/messenger/telegram.ts` | `Telegram`: send, edit, typing, `sendMessageDraft` streaming with a `Thinking…` start, forum topics (create, rename, close, reopen), HTML tables |
| `src/messenger/discord.ts` | `Discord`: send without pings, edit, typing, threads (start, rename, archive); gateway presence |
| `src/messenger/typing.ts` | `typingWhile`: show typing while a piece of work runs, stop when it ends |
| `src/messenger/voice.ts` | `transcribe`: voice note to text through your hook |
| `src/messenger/thread-ledger.ts` | `ThreadLedger`: every thread the Dori posts in, persisted; given to `Slack`, it records each `chat.postMessage` (also raw `call`s) |
| `src/messenger/slack-inbound.ts` | `pollSlackInbound`: threads view, the ledger's threads and unread counts, deduplicated, own messages filtered |
| `src/messenger/slack-presence.ts` | `slackPresence`: hold a user account active |
| `src/routing.ts` | `canLaunch`, `idleLaneFor`: the routing checks |

Every module takes its HTTP, clock and timers as arguments. That is how the tests run without the network.

## Commands

### `dori launch <key> --title T --brief FILE --done "..." [--thread REF] [--model M] [--cwd DIR]`
Opens a lane: appends the footer to the brief, opens a tab, starts the agent, and after 20 seconds checks it: `STARTUP_ERROR` on a known failure in the pane, `STARTUP_OK` only when herdr reports the agent idle or working, and `STARTUP_UNCONFIRMED` (with the last lines) otherwise. Exit 3 on anything but `STARTUP_OK`.

### `dori adopt <key> --pane ID --title T --brief FILE --done "..." [--thread REF]`
Registers a lane that is already running.

### `dori sync [--write]`
Prints `key | thread | pane | session | status` for every open lane and every unregistered agent pane, followed by drift. Read-only unless `--write`, which stores session ids.

### `dori report <key> --kind milestone|blocker|question|halted|done --text TEXT`
Run by a lane. Appends one record to `<stateDir>/lanes/<key>/reports.jsonl` and prints the `[REPORT] <key> | <kind> | <text>` line the lane then sends to the lead pane. Each record is a single append, so the lane and the lead can write at the same time without losing one. The last record is the lane's progress state: `milestone` is running, `blocker` and `question` blocked (a question waits on the owner's answer), `halted` halted, `done` done. The screen grammar takes the same five kinds. Text stays data: newlines are folded into the printed line, never into the journal. A corrupt journal is an error with its line number, never an empty state. Lanes opened by `dori launch` are told to report this way and are marked `reportProtocol: "jsonl-v1"`; launch starts their journal with a `running` activity record, which is not a report and is never posted.

### `dori boot`
Run by the lead after a restart or a compaction, before it trusts what it remembers. It is read-only: it writes no registry record, relaunches nothing and stops no watch. It prints:
- `SLACK authenticated user=... team=...` from `auth.test` when `DORI_SLACK_TOKEN` is set (`SLACK skipped` otherwise). This proves the token, not that messages arrive. It runs last, after the local checks below, and gives up after 10 seconds (`SLACK auth.test timed out after 10000 ms`). A response without a user or team id is `SLACK auth failed`.
- `PANES` with the lead pane's state, then `VANISHED <key> pane=...` for each open lane whose pane is gone (a `verified-done` lane is not flagged), and `UNREGISTERED <panes>` for panes no lane owns. If `herdr pane list` fails, no lane is called vanished.
- `REPORT <key> kind=... at=... state=...` for each launched (`jsonl-v1`) lane's last report, next to its registry status, since the two can disagree after a crash. A journal that holds only records dori wrote itself (the launch, a screen-detected stall) is `NO-REPORT <key>`, never a report, and a launched lane with no `reports.jsonl` yet is `NO-REPORT <key> ... (no journal)`. An adopted lane's journal is not read, as in `freshness`. An unreadable journal is `JOURNAL-ERROR <key>: ...` for that lane only; the other lanes are still checked.
- `CLEANUP <keys> match=<key>:<field>:<pane|key> ...` and `STOP in the owner session only: kill_bash(...)` for persistent watches tied only to finished lanes (closed, verified done, or a `done` report). A watch is tied to a lane only by the lane's pane id, or its key, as a whole argv token of the watch's `command` or `target`; a description is prose and a path segment is not the lane, so a lane keyed `docs` never claims `CI for the docs site` or `tail -F build/docs/out.log`. `match=` names the field that tied it. A watch that mentions an open lane anywhere (description and paths included) is kept. It reads the terminal metadata in `<sessionsDir>/*/extensions/terminal` and the current session's (`PI_SESSION_DIR`, `PI_SESSION_FILE`). Only the session that owns a watch can stop it. Live watches are listed first, then delivery-paused ones (`deliveryPaused=true`, still running, so they still get a stop call). A watch past its `expiresAt` has ended on its own and is listed as `EXPIRED <keys> ... ; nothing to stop`. The metadata path is shell-quoted. A metadata file that cannot be read or parsed is printed as `MONITORS unreadable <path>` and skipped; the other files are still read.

Exit 0 ends with `BOOT checked`. A lane file that cannot be read or parsed, or a lanes path that cannot be listed, is `REGISTRY unreadable <path>`; the other lanes are still checked. Any input that could not be read (Slack, the registry, panes, a journal, metadata) is printed and gives `BOOT incomplete`, exit 1.

### `dori checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...` / `dori checkpoints <key>`
Run by a lane after each completed step, and on resume before doing work. Each step is one line in `<stateDir>/lanes/<key>/checkpoints.jsonl` with its result, evidence and the receipts of remote effects it completed (a push, a merge, a deploy). Recording the same step again with the same data returns the original, unchanged; different data for a recorded step is refused. Writes take an exclusive lock and fsync; a lock left by a crash fails closed, so remove it only after checking no writer is left.

A lane reads its checkpoints before resuming and never repeats a recorded remote effect. A crash between a remote action and its checkpoint is not covered by the journal: read the live remote state first, and use the service's idempotency key where it has one.

### `dori verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]`
Run before a lane claims PR work done. It reads the PR through `gh api` (the PR, every commit with all of its files, the PR's files, then the PR again) and checks:
- every commit's author and committer email is the one in `repoIdentities` for that repo, ignoring case. The name may differ. `noreply@github.com` is accepted only as the committer of a merge commit, even if it is the configured email. A repo with no configured identity fails before anything is read; `loadConfig` drops an entry whose `name` or `email` is not a nonempty string, so such a repo counts as unconfigured;
- a PR with `fix:` or `fix(<scope>):` commits (with or without `!`) that touch source changes at least one test. A test file counts when GitHub lists it as added, modified, renamed, copied or changed (not removed) and it is named as a test (`*.test.*`, `*.spec.*`, `test_*.py`, `*_test.go`, `*_test.py`) or sits in a `test`, `tests` or `__tests__` directory. Nothing under a `fixtures`, `__fixtures__`, `__snapshots__`, `helpers`, `fakes` or `mocks` directory counts. In a test directory, a file that is not named as a test does not count when its name is `setup`, `conftest`, `test-utils`, `fixture(s)`, `helper(s)`, `fake(s)` or `mock(s)`, or when it sits in a `setup`, `conftest` or `test-utils` directory; a file named as a test (`test/setup.test.ts`, `test/helpers.test.ts`) counts. A body line `No test: <reason>` waives this. A fix commit without its own test is a warning, since its test may be in a later commit.

If the head, body or commit count changed between the two reads, or GitHub's answer is incomplete, the result is `FAIL`. Each `gh api` call is killed after 120 seconds, which is also a `FAIL`. Changed UI tests (`.tsx`/`.jsx`, a `ui`, `component(s)`, `feature(s)`, `e2e`, `browser` or `playwright` directory, or DOM calls in the patch) are listed with a shell loop that runs them `--loop` times (default 20) at the reported head. dori never runs the loop. `PASS` exits 0, `FAIL` exits 2.

### `dori claim-done [<key>] --evidence TEXT` / `dori object-done <key> --reason TEXT ...`
The two halves of the done flow. Both message the lane's pane and check that Enter registered.

### `dori close <key> [--note TEXT]`
Closes a lane now. Refuses (exit 2) unless every `Done =` signal reads back live. On success it marks the thread done through `hooks.threadDone`, closes the tab, and removes the lane's worktrees with a plain `git worktree remove`, which refuses a dirty worktree.

### `dori pause <key> [--note TEXT]` / `dori resume <key> [--note TEXT]`
`pause` is for when the owner said wait. It works on a `working` or `not-done` lane. It sends `/goal pause` to the lane's pane, then reads the screen back until the goal command's own line appears on a line of its own: `Goal paused`, or `cannot update goal: no goal exists`, since a lane with no goal has nothing to continue. Only then does it mark the lane `paused` (recorded in its history) and send Escape if a turn is running. The goal is paused first, so stopping the turn cannot hand off to a goal continuation. If the line does not appear, or the send fails, the lane is left as it was and the command prints `PAUSE_UNVERIFIED` and exits 3.

A paused lane is skipped by `freshness`: no nudge, no post. Only `dori resume` ends a pause, on the owner's word. Activity never does, because a paused lane can still be woken by a background result, a queued message or a turn after Escape. If its pane reads `working` on two ticks in a row, `freshness` prints `WORKING-WHILE-PAUSED` once per working stretch (again after it goes idle and is woken, or after a new pause), so the lead can ask the owner, and the lane stays paused.

`resume` sends `/goal resume` and reads back `Goal active` the same way, then restores the status the lane had before the pause (`pausedFrom`) and restarts its quiet time, so a long pause does not turn into an instant nudge. Unconfirmed: `RESUME_UNVERIFIED`, exit 3.

Both print `PAUSED` / `RESUMED` and exit 0 on success. A lane in any other state is refused (`NOT_PAUSED` / `NOT_RESUMED`, exit 2), and a second `pause` is a no-op. `claim-done` and `object-done` on a paused lane move it out of `paused` in the registry while its goal stays paused.

### `dori watch`
Runs forever. Every 30 seconds it prints each new claim once (`LANE_DONE_CLAIMED`). Claims older than `closeAfterMin` are settled: unpushed or uncommitted work and failing signals turn into objections (`LANE_NOT_DONE`); otherwise the lane is closed (`LANE_CLOSED`). The deadline lives in the registry, so a restart picks up where it left off.

### `dori freshness [--loop MIN]`
For working lanes that have gone quiet: a nudge in the pane after `nudgeAfterMin`, then the lane's last `[REPORT]` line posted to its thread after `postAfterMin`, with home paths and pane ids scrubbed. Each happens once per silence. The line is posted only once it is still the last `[REPORT]` line on the next tick (`PENDING-REPORT` the first time) and differs from the line posted last time (`STALE-REPORT` otherwise). A `[REPORT]` line counts when it starts the row or is a whole quoted element of an argv array, the shape lanes send it in (`["herdr", "pane", "run", "<lead pane>", "[REPORT] key | kind | text"]`). Prose that quotes the grammar mid-sentence, and a report whose text is one unfilled placeholder, are not reports. A held-back outcome is printed once per change, not on every tick. A nudge reports its delivery as `delivered` (the agent status moved to working) or `unconfirmed`.

A lane with a `reports.jsonl` journal is read from the journal first. Its last report skips the two-tick `PENDING-REPORT` wait, since it cannot scroll off, and is posted once the thread has had no update for `postAfterMin`, so a lane that reports often still has its latest report posted, at most once per `postAfterMin`. Its time counts as the lane last being heard from, so a fresh report suppresses the nudge. A `blocker`, `question`, `halted` or `done` lane is not nudged, but its report is still posted. A `stalled` lane is neither nudged nor posted: it stopped on a failed compaction or at an idle prompt, so a typed nudge cannot restart it and a person has to look. `STALLED` is printed once per stall for the monitor (see the filter in `setup.md`), and `Working` on the screen returns the lane to running, after which nudges and posts resume. A `jsonl-v1` lane never falls back to scraping the screen. `launch` starts its journal with a `running` activity record, which is not a report, so a lane with no report of its own is `NO-REPORT` and is still watched for a stall; a `jsonl-v1` lane with no journal at all is `NO-REPORT` and is not watched. The screen is still read for activity: a compaction failure with no `Working` line below it, or an idle prompt with no `Working` line and no report for `nudgeAfterMin`, marks the lane `stalled` and prints `STALLED` once; `Working` on the screen moves it back to running. A journal that does not parse skips its lane and prints `JOURNAL-ERROR` with the file and line, once per error; the other lanes are still swept. Adopted lanes ignore the journal and keep the screen path. On the screen, a report is a line that starts with `[REPORT]` (after indentation) or the last quoted element of an argv row such as `["herdr", "pane", "run", "lead:p1", "[REPORT] ..."]`, optionally inside one spawn call. Prose, an instruction or a prompt that quotes the grammar mid-sentence is dropped.

#### Supervision
For lanes with a `reports.jsonl` journal, each `freshness` tick also checks:
- **Ceilings.** `wallMinutes` since the lane opened, and `tokens` and `costUsd` from `supervision.usageArgv`. Reaching one appends a `blocker` report and prints `BLOCKED`. The lane is never killed, closed or sent anything; it waits for the lead, and raising a ceiling alone does not resume it. Limits come from `supervision.defaults`, then `supervision.lanes.<key>`, then `launch --wall-minutes N|none --token-limit N|none --cost-limit N|none`, and are saved on the lane. `null` (`none`) disables one. A malformed `supervision` entry (a ceiling that is not a nonnegative number or `null`, a `lanes` entry that is not an object, an argv or path list that is not strings) stops every command with `invalid supervision <name>`, so a typo never turns a ceiling off.
- **Hung calls.** A `Working` or `Running` timer on the screen that keeps growing from the same start for `hungAfterMinutes`, with no new report, checkpoint or file change for `staleAfterMinutes`, marks the lane stalled (`STALLED`). File changes are git's changed-file list in the lane's `cwd` (`gitActivity`) plus `activityPaths` and `launch --activity-path FILE`; directories are not walked.
- **Usage.** `supervision.usageArgv` is an argv template (`{key}`, `{session}`, `{cwd}`) that prints `{"tokens": N, "costUsd": N}` cumulative totals. Missing or malformed values are unknown, never zero, and a ceiling that cannot be checked prints `WARNING` once. With `usageArgv` set, each reading is appended to the lane's `cost.jsonl`; without it, sweeps record nothing.

Each alert prints once per change. `close` takes one more usage reading, prints `COST <key> tokens=... costUsd=...`, and, when either is known, runs `supervision.recordCostArgv` (`{key}`, `{session}`, `{tokens}`, `{costUsd}`, `{at}`; unknown values are the literal `null`). If that hook fails, close prints `COST <key> not recorded: <reason>` and still closes the lane. A supervision step that fails (an unreadable `supervision.json` or checkpoint journal) prints `SUPERVISION-ERROR <key> <reason>` once per reason; that lane's reports are still read and posted, and the other lanes are still checked. Both hooks run without a shell and time out after 10 seconds. Run one freshness sweeper per lane.

### `dori dead-panes [--loop MIN]`
Prints `DEAD_PANE <id>` once per hour for a pane with no running agent status whose last lines match `deadPanePatterns` on two ticks in a row with the same text. A pane herdr reports as idle, working, blocked or done is never dead. A pane that is neither is unrecognised; three unrecognised ticks in a row print `UNRECOGNISED_PANE <id> ...` once (list non-agent panes in `ignorePanes`).

### `dori guard [--loop MIN]`
Prints `HOST_GUARD ALERT <reasons>` when load, free memory, free disk or the pane count crosses its threshold, and `HOST_GUARD CLEAR` when it recovers. It also prints `COMPUTE_READY` / `COMPUTE_BUSY` as load crosses `loadOk`. Only changes are printed.

### `dori can-launch`
Prints `CAN_LAUNCH` and exits 0 when the host has room for another lane. Otherwise it prints `HOLD <reasons>` and exits 4. The reasons come from the guard's memory, disk and pane-count thresholds. CPU load alone never holds a launch, because it moves too fast to plan around.

### `dori send <slack|telegram|discord> --to TARGET --text TEXT [--thread ID] [--edit ID]`
Posts a message, or edits one with `--edit`. Tokens come from `DORI_SLACK_TOKEN` (plus `DORI_SLACK_COOKIE` for a user token), `DORI_TELEGRAM_TOKEN` or `DORI_DISCORD_TOKEN`. Text containing `$(` is refused, since it can only come from a shell string. Rate limits are retried with the server's wait time; other errors fail at once.

### `dori presence <slack|discord>`
Keeps the account shown as online until stopped.
- **Discord:** the bot connects to the gateway and identifies as online.
- **Slack, user token:** it opens one web-client-type socket and tickles it every minute. Slack shows a user active only while such a socket is open, and auto-aways an idle one after about 30 minutes.
- Run one instance per account. Two writers flip each other's presence.

### `dori inbound slack [--loop MIN]`
Prints `INBOUND <source> <channel> <thread> <ts> <user> <text>`. It reads from three places, each message once:
- `threads-view`: unread replies in threads the account follows (Slack's own Threads view);
- `own-thread`: new replies in any thread the Dori posted in, tagged or not;
- `unread`: DMs, group DMs and channels with unread mentions.

The Dori's own messages and bot messages are skipped. Every message the Dori posts records its thread in `<stateDir>/slack-threads.json`, whichever helper sends it, so a guest's untagged reply under a root posted with a raw API call is still found.

### `dori transcribe <audio-file>`
Runs `hooks.transcribe` and prints the transcript. A failed or empty transcription is an error, never an empty message.

### `dori heavy <label> -- <command ...>`
Waits until load is under `heavyMaxLoad` and one of `heavySlots` is free, then runs the command and frees the slot when it exits. A slot held by a process that no longer exists (or a zombie) is taken over. Use it for full builds and test suites. Installs, focused tests and git do not need it.
