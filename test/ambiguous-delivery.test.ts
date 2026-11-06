import { describe, expect, test } from "bun:test";
import { main } from "../src/cli.ts";
import { dutyTick, send } from "../src/harness.ts";
import { World } from "./fake.ts";

// #89: a delivery that failed after the text may already have reached the pane is never re-sent blindly.

const NOT_READY = '{"error":{"code":"agent_not_ready"}}';

function setup() {
  const w = new World();
  const d = w.deps();
  const lead = w.addPane("w1:p1", "idle");
  d.store.setRole("lead", "w1:p1");
  const count = (pane: string, group: string, verb: string) =>
    w.calls.filter((c) => c.argv[0] === group && c.argv[1] === verb && c.argv[2] === pane).length;
  return { w, d, lead, count };
}

/** Runs the CLI and captures everything it writes: console.log, console.error and raw stderr writes. */
async function captureIo(run: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  const write = process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.join(" ")); };
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await run(), out: out.join("\n"), err: err.join("") };
  } finally {
    console.log = log;
    console.error = error;
    process.stderr.write = write;
  }
}

const HELD_LINE = (target: string) => `HELD ${target}: delivery may or may not have reached the pane; do not resend`;

function addLane(d: ReturnType<World["deps"]>, key: string, paneId: string): void {
  d.store.saveLane({
    key, paneId, tabId: "w1:t9", brief: "/dev/null", cwd: "/", status: "working",
    createdAt: 0, lastActivityAt: 0, nudges: 0, log: [],
  });
}

describe("typed fallback whose Enter failed (#89 A)", () => {
  test("Enter fails 3 times: the next dutyTick presses only Enter and never types the text again", async () => {
    const { w, d, lead, count } = setup();
    w.promptFails.set("w1:p1", NOT_READY);
    w.keyFails = 3;
    expect(await send(d, "lead", "IMPORTANT MESSAGE", "cli")).toBe("QUEUED");
    expect(count("w1:p1", "pane", "send-text")).toBe(1);
    expect(count("w1:p1", "pane", "send-keys")).toBe(3);

    expect(await dutyTick(d)).toEqual([{ pane: "w1:p1", action: "flushed" }]);
    expect(count("w1:p1", "pane", "send-text")).toBe(1);
    expect(count("w1:p1", "pane", "send-keys")).toBe(4);
    expect(w.calls.at(-1)!.argv).toEqual(["pane", "send-keys", "w1:p1", "enter"]);
    expect(lead.received).toEqual(["IMPORTANT MESSAGE"]);
    expect(d.store.queued("w1:p1")).toEqual([]);

    expect(await dutyTick(d)).toEqual([]);
    expect(count("w1:p1", "pane", "send-text")).toBe(1);
    expect(count("w1:p1", "pane", "send-keys")).toBe(4);
  });

  test("the pending Enter is held while the agent is suspended with a shell in front, and pressed once it is back", async () => {
    const { w, d, lead, count } = setup();
    w.promptFails.set("w1:p1", NOT_READY);
    w.keyFails = 3;
    expect(await send(d, "lead", "IMPORTANT MESSAGE", "cli")).toBe("QUEUED");

    // herdr still reports the agent (idle) while its shell is in front: the same agent comes back with its input (#108).
    lead.foreground = "-zsh";
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ pane: "w1:p1", action: "inbox-held" }));
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ pane: "w1:p1", action: "inbox-held" }));
    expect(count("w1:p1", "pane", "send-keys")).toBe(3);

    lead.foreground = undefined;
    expect(await dutyTick(d)).toEqual([{ pane: "w1:p1", action: "flushed" }]);
    expect(count("w1:p1", "pane", "send-keys")).toBe(4);
    expect(count("w1:p1", "pane", "send-text")).toBe(1);
  });
});

describe("ambiguous `agent prompt` failure (#89 B)", () => {
  test("a non-agent_not_ready error: the lead is told exactly once across several dutyTicks and the prompt is not re-sent", async () => {
    const { w, d, lead, count } = setup();
    const lane = w.addPane("w1:p2", "idle");
    w.promptFails.set("w1:p2", "timeout");
    d.store.enqueue("w1:p2", { at: w.clock, from: "cli", text: "SECRET instruction" });

    const ticks = [await dutyTick(d), await dutyTick(d), await dutyTick(d)];
    for (const events of ticks) {
      expect(events).toContainEqual(expect.objectContaining({ pane: "w1:p2", action: "delivery-ambiguous" }));
      expect(events.some((e) => e.action === "flush-failed")).toBe(false);
      expect(JSON.stringify(events)).not.toContain("SECRET");
    }
    expect(count("w1:p2", "agent", "prompt")).toBe(1);
    expect(count("w1:p2", "pane", "send-text")).toBe(0);
    expect(lane.received).toEqual([]);
    const notices = lead.received.filter((m) => m.includes("w1:p2"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).not.toContain("SECRET");
    expect(d.store.queued("w1:p2")).toHaveLength(1);
  });

  test("an ambiguous failure on the lead's own pane is held and not re-sent, with no notice loop", async () => {
    const { w, d, lead, count } = setup();
    w.promptFails.set("w1:p1", "timeout");
    expect(await send(d, "lead", "hello", "cli")).toBe("HELD");
    for (let i = 0; i < 3; i++) await dutyTick(d);
    w.promptFails.delete("w1:p1");
    expect(await dutyTick(d)).toContainEqual(expect.objectContaining({ pane: "w1:p1", action: "delivery-ambiguous" }));
    // one prompt for the message, one for the notice about it; neither is retried
    expect(count("w1:p1", "agent", "prompt")).toBe(2);
    expect(lead.received).toEqual([]);
  });
});

describe("a pending Enter with newer messages queued (#89 review)", () => {
  test("send() of the newer message presses only the pending Enter, returns QUEUED, and keeps the newer message queued", async () => {
    const { w, d, lead, count } = setup();
    d.store.saveInbox("w1:p1", [
      { at: w.clock - 1, from: "cli", text: "FIRST", attempt: { at: w.clock - 1, state: "typed", detail: "key press failed" } },
    ]);
    expect(await send(d, "lead", "SECOND", "cli")).toBe("QUEUED");
    expect(count("w1:p1", "pane", "send-keys")).toBe(1);
    expect(count("w1:p1", "agent", "prompt")).toBe(0);
    expect(d.store.queued("w1:p1").map((m) => m.text)).toEqual(["SECOND"]);

    expect(await dutyTick(d)).toEqual([{ pane: "w1:p1", action: "flushed" }]);
    expect(lead.received).toEqual(["SECOND"]);
    expect(d.store.queued("w1:p1")).toEqual([]);
  });
});

describe("the CLI on an uncertain first delivery (#89 review)", () => {
  test("dori send, ambiguous prompt error: prints HELD, exits 3, never shows the text, and holds exactly one entry", async () => {
    const { w, d, count } = setup();
    w.addPane("w1:p2", "idle");
    w.promptFails.set("w1:p2", "timeout");
    const r = await captureIo(() => main(["send", "w1:p2", "--text", "SECRET instruction"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(HELD_LINE("w1:p2"));
    expect(r.out + r.err).not.toContain("SECRET");
    const held = d.store.queued("w1:p2");
    expect(held).toHaveLength(1);
    expect(held[0]!.attempt?.state).toBe("ambiguous");
    expect(count("w1:p2", "agent", "prompt")).toBe(1);
  });

  test("dori send, typed text whose Enter failed: prints QUEUED and exits 0 with one typed entry", async () => {
    const { w, d } = setup();
    w.addPane("w1:p2", "idle");
    w.promptFails.set("w1:p2", NOT_READY);
    w.keyFails = 3;
    const r = await captureIo(() => main(["send", "w1:p2", "--text", "SECRET instruction"], d));
    expect(r.code).toBe(0);
    expect(r.out).toBe("QUEUED w1:p2");
    expect(r.out + r.err).not.toContain("SECRET");
    expect(d.store.queued("w1:p2").map((m) => m.attempt?.state)).toEqual(["typed"]);
  });

  test("dori report, ambiguous delivery to the lead: no crash, prints HELD for the lead, exits 3, report held once", async () => {
    const { w, d } = setup();
    addLane(d, "fix-x", "w1:p2");
    w.addPane("w1:p2", "working");
    w.promptFails.set("w1:p1", "timeout");
    const r = await captureIo(() => main(["report", "fix-x", "--text", "SECRET progress"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(`REPORTED fix-x\n${HELD_LINE("lead")}`);
    expect(r.out + r.err).not.toContain("SECRET");
    const fromLane = d.store.queued("w1:p1").filter((m) => m.from === "fix-x");
    expect(fromLane).toHaveLength(1);
    expect(fromLane[0]!.attempt?.state).toBe("ambiguous");
    expect(d.store.lane("fix-x")!.log.at(-1)).toMatchObject({ kind: "report", text: "SECRET progress" });
  });

  test("dori ready, ambiguous delivery to the lead: no crash, prints HELD for the lead, exits 3, READY recorded", async () => {
    const { w, d } = setup();
    addLane(d, "fix-x", "w1:p2");
    w.addPane("w1:p2", "idle");
    w.promptFails.set("w1:p1", "timeout");
    const r = await captureIo(() => main(["ready", "fix-x", "--text", "SECRET answer", "--evidence", "https://example.com/pr/1"], d));
    expect(r.code).toBe(3);
    expect(r.out).toBe(`READY fix-x\n${HELD_LINE("lead")}`);
    expect(r.out + r.err).not.toContain("SECRET");
    expect(d.store.queued("w1:p1").filter((m) => m.from === "fix-x")).toHaveLength(1);
    expect(d.store.lane("fix-x")!.status).toBe("ready");
  });
});

describe("control", () => {
  test("normal delivery is unchanged: delivered once through agent prompt, nothing typed, inbox empty", async () => {
    const { w, d, lead, count } = setup();
    expect(await send(d, "lead", "hello", "cli")).toBe("DELIVERED");
    expect(lead.received).toEqual(["hello"]);
    expect(count("w1:p1", "agent", "prompt")).toBe(1);
    expect(count("w1:p1", "pane", "send-text")).toBe(0);
    expect(d.store.queued("w1:p1")).toEqual([]);
    expect(await dutyTick(d)).toEqual([]);
    expect(count("w1:p1", "agent", "prompt")).toBe(1);
  });
});
