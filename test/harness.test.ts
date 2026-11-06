import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli.ts";
import { done, dutyTick, mergeGate, ready, Refusal, report, review, send, startLane } from "../src/harness.ts";
import { World } from "./fake.ts";

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  const brief = join(d.store.root, "brief.md");
  writeFileSync(brief, "Fix the flaky login test.");
  return { w, d, lead, brief };
}

describe("lanes", () => {
  test("start opens a tab, launches omo with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    expect(pane.ran[0]).toStartWith("omo 'Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("dori ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in ${lane.paneId}`]);
    await expect(startLane(d, "fix-login", brief, { workspace: "w1" })).rejects.toThrow(Refusal);
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { workspace: "w1" })).rejects.toThrow(`lane key "${key}" is reserved for the ${key} role`);
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toBe("w1:p1");
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { workspace: "w1" });
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["dori.lane_started", "dori.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    expect(w.panes.has(lane.paneId)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});

describe("pane messaging", () => {
  test("a busy lead is never interrupted: messages queue and arrive as one batch when it goes idle", async () => {
    const { d, lead, brief } = setup();
    await startLane(d, "a-lane", brief, { workspace: "w1" });
    lead.received.length = 0;
    lead.status = "working";
    await report(d, "a-lane", "tests red, investigating");
    expect(await send(d, "lead", "second note", "a-lane")).toBe("QUEUED");
    expect(lead.received).toEqual([]);
    lead.status = "idle";
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("2 messages arrived while you were busy");
    expect(lead.received[0]).toContain("[REPORT a-lane] tests red, investigating");
    expect(lead.received[0]).toContain("second note");
  });

  test("an omo pane that herdr refuses `agent prompt` for (agent_not_ready) still gets the text typed in", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    expect(await send(d, "lead", "hello\n\nlead", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello / lead"]);
    expect(w.calls).toContainEqual({ cmd: "herdr", argv: ["pane", "send-keys", "w1:p1", "enter"] });
  });

  test("a failing Enter is retried without typing the text again; after 3 failures it is thrown", async () => {
    const { w, d, lead } = setup();
    const enters = () => w.calls.filter((c) => c.argv[1] === "send-keys").length;
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    w.keyFails = 2;
    await d.herdr.deliver("w1:p1", "once");
    expect(lead.received).toEqual(["once"]);
    expect(enters()).toBe(3);
    w.keyFails = 5;
    await expect(d.herdr.deliver("w1:p1", "twice")).rejects.toThrow("key press failed");
    expect(lead.received).toEqual(["once", "twice"]);
    expect(enters()).toBe(6);
  });

  test("another `agent prompt` failure for a message that merely mentions agent_not_ready is still thrown", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", "herdr exploded");
    await expect(d.herdr.deliver("w1:p1", "a lane quoted agent_not_ready here")).rejects.toThrow("herdr exploded");
    expect(lead.received).toEqual([]);
  });

  test("the typed fallback trims leading and trailing newlines instead of leaving a dangling ' / '", async () => {
    const { w, d, lead } = setup();
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    await d.herdr.deliver("w1:p1", "\n\nhello\nworld\n\n");
    expect(lead.received).toEqual(["hello / world"]);
  });

  test("agent_not_ready on a pane that is now a plain shell types nothing and reports not delivered", async () => {
    const { w, d } = setup();
    const shell = w.addPane("w1:p7", "shell");
    w.promptFails.set("w1:p7", '{"error":{"code":"agent_not_ready"}}');
    await expect(d.herdr.deliver("w1:p7", "rm -rf nothing")).resolves.toBe(false);
    expect(shell.received).toEqual([]);
  });

  test("unknown targets are refused instead of guessed", async () => {
    const { d } = setup();
    await expect(send(d, "nobody", "hi", "cli")).rejects.toThrow("unknown target");
  });
});

describe("duty loop", () => {
  test("nudges an idle lane at 10 and 20 minutes, escalates at 40, and ignores WAITING lanes", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { workspace: "w1" });
    const pane = w.panes.get(lane.paneId)!;
    pane.status = "idle";
    const at = async (min: number) => { w.clock = lane.createdAt + min * 60_000; return dutyTick(d); };
    expect(await at(5)).toEqual([]);
    expect(await at(10)).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(pane.received.at(-1)).toContain("idle for 10 minutes");
    expect(await at(15)).toEqual([]);
    expect(await at(20)).toContainEqual({ lane: "quiet", action: "nudge-2" });
    expect(await at(40)).toContainEqual({ lane: "quiet", action: "escalated" });
    expect(lead.received.at(-1)).toContain("[ESCALATE quiet]");
    expect(await at(90)).toEqual([]);

    const waiting = await startLane(d, "blocked-on-ci", brief, { workspace: "w1" });
    w.panes.get(waiting.paneId)!.status = "idle";
    await report(d, "blocked-on-ci", "WAITING: CI", "waiting");
    w.clock += 60 * 60_000;
    expect((await dutyTick(d)).filter((e) => e.lane === "blocked-on-ci")).toEqual([]);
  });

  test("a failing inbox flush on one pane does not stop the loop for the other panes", async () => {
    const { w, d, lead } = setup();
    const broken = w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    d.store.enqueue("w1:p1", { at: w.clock, from: "cli", text: "to lead" });
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p9", action: "delivery-ambiguous", detail: expect.stringContaining("herdr exploded") });
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received).toHaveLength(1);
    expect(lead.received[0]).toContain("to lead");
    expect(broken.received).toEqual([]);
  });

  test("a failing lane-phase delivery is recorded as lane-failed and does not stop the other lanes", async () => {
    const { w, d, brief } = setup();
    const lost = await startLane(d, "lost-lane", brief, { workspace: "w1" });
    const stuck = await startLane(d, "stuck-lane", brief, { workspace: "w1" });
    const fine = await startLane(d, "fine-lane", brief, { workspace: "w1" });
    w.panes.delete(lost.paneId);
    w.panes.get(stuck.paneId)!.status = "idle";
    w.panes.get(fine.paneId)!.status = "idle";
    w.promptFails.set("w1:p1", "lead exploded");
    w.promptFails.set(stuck.paneId, "stuck exploded");
    w.clock = fine.createdAt + 10 * 60_000;
    const events = await dutyTick(d);
    expect(events).toContainEqual({ lane: "lost-lane", action: "lane-failed", detail: expect.stringContaining("lead exploded") });
    expect(events).toContainEqual({ lane: "stuck-lane", action: "lane-failed", detail: expect.stringContaining("stuck exploded") });
    expect(events).toContainEqual({ lane: "fine-lane", action: "nudge-1" });
    expect(w.panes.get(fine.paneId)!.received.at(-1)).toContain("idle for 10 minutes");
  });

  test("a LOST notice whose Enter failed once still reaches the lead on the next tick, exactly once", async () => {
    const { w, d, lead, brief } = setup();
    const gone = await startLane(d, "gone-lane", brief, { workspace: "w1" });
    lead.received.length = 0;
    w.panes.delete(gone.paneId);
    w.promptFails.set("w1:p1", '{"error":{"code":"agent_not_ready"}}');
    w.keyFails = 3;
    expect(await dutyTick(d)).toContainEqual({ lane: "gone-lane", action: "lane-failed", detail: expect.stringContaining("key press failed") });
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
    expect(await dutyTick(d)).toEqual([]);
    expect(lead.received.filter((m) => m.includes("[LOST gone-lane]"))).toHaveLength(1);
  });

  test("the delivery-ambiguous detail is herdr's first output line, never the queued message", async () => {
    const { w, d } = setup();
    w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded\nsecond line");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "SECRET queued message" });
    const events = await dutyTick(d);
    expect(events).toEqual([{ pane: "w1:p9", action: "delivery-ambiguous", detail: "herdr exploded" }]);
  });

  test("the duty loop prints a delivery-ambiguous line with the reason", async () => {
    const { w, d } = setup();
    w.addPane("w1:p9", "idle");
    w.promptFails.set("w1:p9", "herdr exploded");
    d.store.enqueue("w1:p9", { at: w.clock, from: "cli", text: "to broken" });
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "--once"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("DUTY w1:p9 delivery-ambiguous: ");
    expect(lines[0]).toContain("herdr exploded");
  });

  test("kill switch: a stopped duty loop flushes, nudges and escalates nothing; resume delivers what was held", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "quiet", brief, { workspace: "w1" });
    w.panes.get(lane.paneId)!.status = "idle";
    lead.status = "working";
    expect(await send(d, "lead", "held note", "cli")).toBe("QUEUED");
    lead.status = "idle";
    lead.received.length = 0;
    w.clock = lane.createdAt + 40 * 60_000;
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      expect(await main(["duty", "stop", "--text", "maintenance"], d)).toBe(0);
      expect(await main(["duty", "--once"], d)).toBe(0);
      expect(await main(["duty", "status"], d)).toBe(0);
    } finally {
      console.log = log;
    }
    expect(lines).toEqual(["DUTY STOPPED", "DUTY stopped: maintenance", "stopped: maintenance"]);
    expect(lead.received).toEqual([]);
    expect(d.store.lane("quiet")!.nudges).toBe(0);
    expect(d.store.stop()).toBeUndefined();
    expect(w.dutyCounts).toEqual([]);

    await main(["duty", "resume"], d);
    const events = await dutyTick(d);
    expect(events).toContainEqual({ pane: "w1:p1", action: "flushed" });
    expect(events).toContainEqual({ lane: "quiet", action: "nudge-1" });
    expect(lead.received).toEqual(["held note"]);
  });

  test("a working lane counts as activity; a vanished pane is reported LOST", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "busy", brief, { workspace: "w1" });
    w.panes.get(lane.paneId)!.status = "working";
    w.clock += 30 * 60_000;
    expect(await dutyTick(d)).toEqual([]);
    expect(d.store.lane("busy")!.lastActivityAt).toBe(w.clock);
    expect(w.touches).toBeGreaterThan(0);
    w.panes.delete(lane.paneId);
    expect(await dutyTick(d)).toContainEqual({ lane: "busy", action: "lost" });
    expect(lead.received.at(-1)).toContain("[LOST busy]");
  });
});

describe("review + merge gate", () => {
  const head = "a".repeat(40);
  function gh(w: World, checks: unknown[]) {
    w.gh = (argv) => {
      if (argv[1] === "view") return { code: 0, stdout: JSON.stringify({ headRefOid: head }) };
      if (argv[1] === "checks") return { code: 0, stdout: JSON.stringify(checks) };
      if (argv[1] === "merge") return { code: 0, stdout: "" };
      return { code: 1, stdout: "" };
    };
  }

  test("merge is refused without a receipt, with an empty check list, with red checks; allowed at CLEAR + green", async () => {
    const { w, d } = setup();
    gh(w, []);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("no review receipt");
    w.reviewer = () => ({ code: 0, stdout: "HIGH src/a.ts:3 ...\nVERDICT: BLOCK" });
    expect((await review(d, "o/r#7")).verdict).toBe("BLOCK");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("is BLOCK");
    w.reviewer = () => ({ code: 0, stdout: "no findings\nVERDICT: CLEAR" });
    await review(d, "o/r#7", "some/model");
    expect(d.store.receipt("o/r#7", head)!.model).toBe("some/model");
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("never green");
    gh(w, [{ name: "test", bucket: "fail" }, { name: "lint", bucket: "pass" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("test=fail");
    gh(w, [{ name: "test", bucket: "skipping" }]);
    await expect(mergeGate(d, "o/r#7")).rejects.toThrow("every check was skipped");
    gh(w, [{ name: "test", bucket: "pass" }, { name: "docs", bucket: "skipping" }]);
    expect(await mergeGate(d, "o/r#7")).toBe(`MERGED o/r#7 head=${head}`);
    expect(w.calls.at(-1)!.argv).toContain("--match-head-commit");
    expect(w.usage.filter((e) => e.name === "dori.merge_decided").map((e) => (e as { outcome: string }).outcome))
      .toEqual(["no_receipt", "review_block", "no_checks", "checks_red", "checks_all_skipped", "merged"]);
    expect(w.usage.filter((e) => e.name === "dori.review_completed")).toHaveLength(2);
  });

  test("a reviewer without a VERDICT line writes no receipt", async () => {
    const { w, d } = setup();
    gh(w, []);
    w.reviewer = () => ({ code: 0, stdout: "looks fine I guess" });
    await expect(review(d, "o/r#8")).rejects.toThrow("no VERDICT");
    expect(d.store.receipt("o/r#8", head)).toBeUndefined();
  });
});
