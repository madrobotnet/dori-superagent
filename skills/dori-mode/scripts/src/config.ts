import { homedir } from "node:os";
import { join } from "node:path";

import type { SupervisionOptions } from "./supervision.ts";
import type { CommitIdentity } from "./verify-pr.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = {
  readonly stateDir: string;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly sessionsDir: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
  readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
  readonly supervision: SupervisionOptions;
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omo", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  sessionsDir: join(home, ".omo", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  repoIdentities: {},
  supervision: { hungAfterMinutes: 20, staleAfterMinutes: 20, defaults: { wallMinutes: null, tokens: null, costUsd: null } },
});

export const configPath = (): string => process.env.DORI_CONFIG ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

const isIdentity = (value: unknown): value is CommitIdentity => {
  const v = value as { name?: unknown; email?: unknown } | null;
  return typeof v === "object" && v !== null && typeof v.name === "string" && !!v.name.trim() && typeof v.email === "string" && !!v.email.trim();
};

// The file is untrusted JSON: keep only well-formed identities, so a bad entry reads as an unconfigured repo.
const repoIdentities = (value: unknown): Record<string, CommitIdentity> =>
  typeof value !== "object" || value === null || Array.isArray(value) ? {}
    : Object.fromEntries(Object.entries(value).flatMap(([repo, identity]) => (isIdentity(identity) ? [[repo.toLowerCase(), identity]] : [])));

export class ConfigError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A malformed supervision entry stops with its name: dropping it could turn a ceiling off, and keeping it would crash
// every sweep later.
const checkSupervision = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid supervision: expected an object");
  for (const name of ["defaults", "lanes"] as const) {
    if (value[name] !== undefined && !isRecord(value[name])) throw new ConfigError(`invalid supervision ${name}: expected an object`);
  }
  for (const [key, budget] of Object.entries(isRecord(value.lanes) ? value.lanes : {})) {
    if (!isRecord(budget)) throw new ConfigError(`invalid supervision lanes.${key}: expected an object`);
  }
  for (const name of ["usageArgv", "recordCostArgv", "activityPaths"] as const) {
    const list = value[name];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      throw new ConfigError(`invalid supervision ${name}: expected an array of strings`);
    }
  }
  if (value.gitActivity !== undefined && typeof value.gitActivity !== "boolean") throw new ConfigError("invalid supervision gitActivity: expected true or false");
};

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const base = defaultConfig(home);
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkSupervision(raw.supervision);
  const merged: DoriConfig = {
    ...base, ...raw, guard: { ...base.guard, ...raw.guard }, hooks: { ...base.hooks, ...raw.hooks }, repoIdentities: repoIdentities(raw.repoIdentities),
    supervision: { ...base.supervision, ...raw.supervision, defaults: { ...base.supervision.defaults, ...raw.supervision?.defaults } },
  };
  for (const [name, value] of Object.entries({
    hungAfterMinutes: merged.supervision.hungAfterMinutes,
    staleAfterMinutes: merged.supervision.staleAfterMinutes,
    ...merged.supervision.defaults,
  })) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new ConfigError(`invalid supervision ${name}: expected a nonnegative number or null`);
  }
  for (const [key, budget] of Object.entries(merged.supervision.lanes ?? {})) {
    for (const [name, value] of Object.entries(budget)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new ConfigError(`invalid supervision lanes.${key}.${name}: expected a nonnegative number or null`);
    }
  }
  return {
    ...merged,
    stateDir: expandHome(process.env.DORI_STATE_DIR ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: process.env.DORI_LEAD_PANE ?? merged.leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
