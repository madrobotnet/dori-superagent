// Thin, typed wrapper over the herdr CLI. Every call goes through one injectable `Exec`,
// so tests can replace herdr with a recorder and the e2e test can point at an isolated session.

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Exec = (cmd: string, argv: readonly string[]) => Promise<ExecResult>;

export const spawnExec: Exec = async (cmd, argv) => {
  const proc = Bun.spawn([cmd, ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export class HerdrError extends Error {
  constructor(readonly argv: readonly string[], readonly result: ExecResult) {
    super(`herdr ${argv.join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim()}`);
  }
}

/**
 * A delivery that failed after the message may already have reached the pane (#89): sending it again could deliver
 * it twice. `typed`: the text is in the pane's input and only the Enter that submits it is missing.
 */
export class DeliveryUncertain extends Error {
  constructor(readonly failure: unknown, readonly typed: boolean, readonly agent?: AgentIdentity) {
    super(failure instanceof Error ? failure.message : String(failure));
  }
}

/**
 * Which agent typed text went into (#108), as herdr reports it: `agent` is the agent name from `pane get`, `pgid` the
 * foreground process group id from `pane process-info`. `pane get`'s `revision` is not used: in herdr 0.9.5 it stayed
 * the same across an omo exit and restart in the same pane, so it cannot tell two agents apart.
 */
export type AgentIdentity = { readonly agent?: string; readonly pgid?: number };

/** What submitTyped did: pressed Enter, found the agent away for now (suspended), or found a different or no agent. */
export type SubmitResult = "submitted" | "wait" | "changed";

/** Agent lifecycle as herdr reports it. `shell` = no recognised agent in the pane. */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown" | "shell" | "gone";

/** The terminal needs a moment to finish a bracketed paste before an Enter is read as a submit. */
const PASTE_SETTLE_MS = 400;

/** How often the Enter that submits typed fallback text is tried before the delivery is reported as failed. */
const ENTER_ATTEMPTS = 3;

const INPUT_RULE = /^─{10,}$/;
/** Lines omo prints below its input box (cwd/model line, status line); more than this and the box is not at the bottom. */
const FOOTER_MAX_LINES = 3;

/**
 * True only when an omo screen positively shows its idle input at the bottom: a bare rule, an empty `❯`
 * line, a bare rule, and no `esc to interrupt` anywhere. Anything else (a turn, a dialog, a draft in the
 * input, an unknown layout) is false, so the caller keeps queueing. Stopgap for #62: herdr reports an omo
 * whose live monitors or background cells are running as `working` even between turns.
 */
export function omoScreenIdle(screen: string): boolean {
  if (screen.includes("esc to interrupt")) return false;
  const lines = screen.split("\n").map((l) => l.trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const input = lines.lastIndexOf("❯");
  if (input < 1 || input + 1 >= lines.length) return false;
  if (!INPUT_RULE.test(lines[input - 1]!) || !INPUT_RULE.test(lines[input + 1]!)) return false;
  return lines.length - 1 - (input + 1) <= FOOTER_MAX_LINES;
}

const SHELLS: ReadonlySet<string> = new Set([
  "sh", "ash", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell", "busybox",
]);
const baseName = (value: unknown): string => String(value ?? "").replace(/^-/, "").split("/").pop()!.toLowerCase();
// A shell runs a command (not a prompt) only with an explicit command flag: -c, also inside combined short flags such
// as -lc, or PowerShell's -Command/-File/-EncodedCommand (whole words only: its other long flags contain a 'c'). Any other operand (a script path, --rcfile FILE, -o OPT) stays held.
const runsCommand = (shell: string, arg: string): boolean =>
  shell === "pwsh" || shell === "powershell"
    ? /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(arg)
    : /^-[A-Za-z]*c[A-Za-z]*$/.test(arg);
// PowerShell's -NoExit (any prefix it accepts: -noe, -noex, -noexi, -noexit, one or two dashes) keeps an interactive
// prompt after the command runs, so that shell is held.
const keepsPrompt = (shell: string, arg: string): boolean => (shell === "pwsh" || shell === "powershell") && /^--?noe(x(i(t)?)?)?$/i.test(arg);

/**
 * True when `pane process-info` shows an interactive shell in the pane's foreground process group, or cannot be read.
 * An agent suspended with Ctrl+Z is still reported `idle` by herdr while its shell is in front (#66). A shell that runs
 * a command flag (`sh -c ...`) is an agent's child, not a prompt, and does not count; any other shell, a script
 * runner such as `bash script.sh` included, is held.
 */
export function interactiveShellInFront(processInfo: unknown): boolean {
  const procs = (processInfo as { foreground_processes?: unknown } | undefined)?.foreground_processes;
  if (!Array.isArray(procs) || procs.length === 0) return true;
  for (const proc of procs as { name?: unknown; argv?: unknown }[]) {
    let name = baseName(proc?.name);
    let args = Array.isArray(proc?.argv) ? proc.argv.map(String).slice(1) : undefined;
    if (name === "busybox" && args && args.length > 0) [name, args] = [baseName(args[0]), args.slice(1)];
    if (!SHELLS.has(name)) continue;
    if (args === undefined) return true;
    if (!args.some((a) => runsCommand(name, a)) || args.some((a) => keepsPrompt(name, a))) return true;
  }
  return false;
}

export type PaneRef = { readonly paneId: string; readonly tabId: string; readonly workspaceId: string };

export class Herdr {
  constructor(
    private readonly exec: Exec = spawnExec,
    private readonly session: string | undefined = process.env["DORI_HERDR_SESSION"],
  ) {}

  private async call(argv: readonly string[]): Promise<Record<string, unknown>> {
    const full = this.session ? ["--session", this.session, ...argv] : [...argv];
    const res = await this.exec("herdr", full);
    if (res.code !== 0) throw new HerdrError(full, res);
    const text = res.stdout.trim();
    if (!text.startsWith("{")) return {};
    const parsed = JSON.parse(text) as { result?: Record<string, unknown> };
    return parsed.result ?? {};
  }

  async createWorkspace(label: string, cwd: string): Promise<PaneRef> {
    const r = await this.call(["workspace", "create", "--label", label, "--cwd", cwd, "--no-focus"]);
    return toPaneRef(r["root_pane"]);
  }

  async createTab(label: string, cwd: string, workspaceId?: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const argv = ["tab", "create", "--label", label, "--cwd", cwd, "--no-focus"];
    if (workspaceId) argv.push("--workspace", workspaceId);
    for (const [k, v] of Object.entries(env)) argv.push("--env", `${k}=${v}`);
    const r = await this.call(argv);
    return toPaneRef(r["root_pane"]);
  }

  async split(paneId: string, cwd: string, env: Record<string, string> = {}): Promise<PaneRef> {
    const argv = ["pane", "split", paneId, "--direction", "down", "--ratio", "0.3", "--cwd", cwd, "--no-focus"];
    for (const [k, v] of Object.entries(env)) argv.push("--env", `${k}=${v}`);
    const r = await this.call(argv);
    return toPaneRef(r["pane"]);
  }

  async run(paneId: string, commandLine: string): Promise<void> {
    await this.call(["pane", "run", paneId, commandLine]);
  }

  async status(paneId: string): Promise<AgentStatus> {
    return (await this.paneAgent(paneId)).status;
  }

  /** `pane get`: the agent status and, when an agent is detected, its name. */
  private async paneAgent(paneId: string): Promise<{ status: AgentStatus; agent?: string }> {
    let pane: Record<string, unknown>;
    try {
      pane = (await this.call(["pane", "get", paneId]))["pane"] as Record<string, unknown>;
    } catch (e) {
      if (e instanceof HerdrError && /not.?found/i.test(e.message)) return { status: "gone" };
      throw e;
    }
    if (!pane) return { status: "gone" };
    if (!pane["agent"]) return { status: "shell" };
    const s = String(pane["agent_status"] ?? "unknown");
    return { status: (["idle", "working", "blocked", "done"].includes(s) ? s : "unknown") as AgentStatus, agent: String(pane["agent"]) };
  }

  /**
   * Delivers one message to the agent in a pane as a single argv element: nothing in it is ever expanded by a shell.
   * Returns false, having typed nothing, when the pane turns out to have no running agent: text typed into a bare
   * shell runs as a command (#66), so the caller keeps the message queued. Throws DeliveryUncertain when the
   * message may already be in the pane (#89); the caller must not send it again as is.
   */
  async deliver(paneId: string, text: string): Promise<boolean> {
    if (await this.shellInForeground(paneId)) return false;
    try {
      await this.call(["agent", "prompt", paneId, text]);
      return true;
    } catch (e) {
      // herdr only accepts `agent prompt` for agents it started itself (`herdr agent start`); an omo launched
      // with `pane run` is detected but refused. Fall back to typing the text and pressing Enter.
      // Match herdr's own output, never e.message: that carries argv, which includes the delivered text.
      // Any other failure (a timeout, say) may come after herdr handed the prompt over: it is ambiguous.
      if (!(e instanceof HerdrError) || !/agent_not_ready/.test(e.result.stderr || e.result.stdout)) throw new DeliveryUncertain(e, false);
      // agent_not_ready also covers an agent that exited and left a shell in front: typing would run the text there.
      // Re-read right before typing (#66): only a pane that still has an agent gets keystrokes.
      const { status: st, agent } = await this.paneAgent(paneId);
      if (st === "shell" || st === "gone") return false;
      const front = await this.foreground(paneId);
      if (front.shell) return false;
      // A multi-line paste swallows the Enter that follows it, so type the message as one line.
      // A failed send-text may still have typed some or all of it: ambiguous as well.
      try {
        await this.call(["pane", "send-text", paneId, text.trim().replace(/\s*\n\s*/g, " / ")]);
      } catch (err) {
        throw new DeliveryUncertain(err, false);
      }
      await Bun.sleep(PASTE_SETTLE_MS);
      await this.pressEnter(paneId, { agent, pgid: front.pgid });
      return true;
    }
  }

  /**
   * Submits text that an earlier deliver typed into `typedInto` but could not submit: presses only Enter, never types
   * the text again. `changed`, pressing nothing: herdr sees no agent in the pane, or a different one (another name or
   * foreground process group), so the typed text is not in this input (#108). `wait`, pressing nothing: the agent is
   * still reported but a shell is in front (suspended with Ctrl+Z, #66/#69), or the lookup failed.
   */
  async submitTyped(paneId: string, typedInto: AgentIdentity = {}): Promise<SubmitResult> {
    const { status: st, agent } = await this.paneAgent(paneId);
    if (st === "gone") return "wait";
    if (st === "shell") return "changed";
    const front = await this.foreground(paneId);
    if (front.shell) return "wait";
    if (typedInto.agent !== undefined && agent !== typedInto.agent) return "changed";
    if (typedInto.pgid !== undefined && front.pgid !== typedInto.pgid) return "changed";
    await this.pressEnter(paneId, { agent, pgid: front.pgid });
    return "submitted";
  }

  /** The text is already in the pane: retry only the Enter, so a flaky key press never re-types the message. */
  private async pressEnter(paneId: string, typedInto: AgentIdentity): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.call(["pane", "send-keys", paneId, "enter"]);
        return;
      } catch (err) {
        if (attempt >= ENTER_ATTEMPTS) throw new DeliveryUncertain(err, true, typedInto);
      }
    }
  }

  /** See interactiveShellInFront. A failed or unreadable lookup is doubt: it holds delivery and says so on stderr. */
  async shellInForeground(paneId: string): Promise<boolean> {
    return (await this.foreground(paneId)).shell;
  }

  /** `pane process-info`: whether a shell is in front (see interactiveShellInFront) and the foreground process group. */
  private async foreground(paneId: string): Promise<{ shell: boolean; pgid?: number }> {
    try {
      const info = (await this.call(["pane", "process-info", "--pane", paneId]))["process_info"];
      const pgid = (info as { foreground_process_group_id?: unknown } | undefined)?.foreground_process_group_id;
      return { shell: interactiveShellInFront(info), ...(typeof pgid === "number" ? { pgid } : {}) };
    } catch (e) {
      const reason = e instanceof HerdrError ? (e.result.stderr || e.result.stdout).trim() : String(e);
      process.stderr.write(`dori: herdr pane process-info failed for ${paneId} (${reason}); holding delivery\n`);
      return { shell: true };
    }
  }

  /**
   * The operator's explicit `dori send --to-shell`: types text + Enter into a pane that has no agent. The status is
   * re-read right before typing; if an agent is there now, nothing is typed and false is returned.
   */
  async typeIntoShell(paneId: string, text: string): Promise<boolean> {
    if ((await this.status(paneId)) !== "shell") return false;
    await this.call(["pane", "send-text", paneId, text]);
    await this.call(["pane", "send-keys", paneId, "enter"]);
    return true;
  }

  async read(paneId: string, lines = 80): Promise<string> {
    const full = this.session ? ["--session", this.session] : [];
    const res = await this.exec("herdr", [...full, "pane", "read", paneId, "--lines", String(lines), "--source", "recent"]);
    if (res.code !== 0) throw new HerdrError(["pane", "read", paneId], res);
    return res.stdout;
  }

  async close(paneId: string): Promise<void> {
    await this.call(["pane", "close", paneId]);
  }
}

function toPaneRef(v: unknown): PaneRef {
  const o = (v ?? {}) as Record<string, unknown>;
  const paneId = String(o["pane_id"] ?? "");
  if (!paneId) throw new Error("herdr did not return a pane id");
  return { paneId, tabId: String(o["tab_id"] ?? ""), workspaceId: String(o["workspace_id"] ?? "") };
}

export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
