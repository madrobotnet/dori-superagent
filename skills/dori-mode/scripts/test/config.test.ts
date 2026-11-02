import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";

import { fill, loadConfig } from "../src/config.ts";
import { withState } from "./fakes.ts";

const state = withState();
afterEach(() => {
  delete process.env.DORI_STATE_DIR;
});

test("the shipped example config loads, with ~ paths expanded and unset fields defaulted", async () => {
  const c = await loadConfig(join(import.meta.dir, "../../references/config.example.json"), "/home/ana");
  expect(c.stateDir).toBe("/home/ana/.dori/state");
  expect(c.defaultCwd).toBe("/home/ana/code/my-project");
  expect(c.closeAfterMin).toBe(5);
  expect(c.guard.diskFreeMinGb).toBe(50);
});

test("a missing config file falls back to defaults and DORI_STATE_DIR wins over the file", async () => {
  process.env.DORI_STATE_DIR = state.dir;
  const c = await loadConfig("/nonexistent/config.json", "/home/ana");
  expect(c.stateDir).toBe(state.dir);
  expect(c.agentCommand).toEqual(["omo", "--model", "{model}", "{prompt}"]);
});

test("repoIdentities keys are matched as lowercase owner/repo, whatever case the file uses", async () => {
  const path = join(state.dir, "config.json");
  await Bun.write(path, JSON.stringify({ repoIdentities: { "Acme/App": { name: "Example Dev", email: "dev@example.com" } } }));
  const c = await loadConfig(path, "/home/ana");
  expect(c.repoIdentities["acme/app"]).toEqual({ name: "Example Dev", email: "dev@example.com" });
});

test("hook templates fill each argument separately, so text with spaces or quotes stays one argument", () => {
  const argv = fill(["notify", "--thread", "{thread}", "--text", "{text}"], { thread: "chat:1/2", text: `it's "done"; rm -rf /` });
  expect(argv).toEqual(["notify", "--thread", "chat:1/2", "--text", `it's "done"; rm -rf /`]);
});
