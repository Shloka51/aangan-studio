// The Vaani adapter drives the same core as the harness, over a real local WebSocket,
// using a fake Vaani client. No telephony, no paid APIs, no network beyond localhost.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calcomLink } from "@/adapters/booking/calcom";
import { rulesBrain } from "@/adapters/brain";
import type { Transport } from "@/adapters/handoff/telegram";
import { handleVaaniEvent, newCallerText, parseVaaniEvent, vaaniGreeting } from "@/adapters/voice/vaani";
import { PRICING_DEFLECTION } from "@/core/knowledge";
import { findPricingViolations } from "@/core/guardrail";
import { createVaaniServer } from "@/server/vaani-ws";
import { MemoryStore } from "@/store/memory";
import { fakeVaaniCall } from "./support/fake-vaani";
import { loadFixtures } from "./support/fixtures";

const quiet: Transport = { send: async () => ({ status: "sent" }) };
const TOKEN = "test-byol-token";
const store = new MemoryStore();
const finished = new Map<string, () => void>();
const done = (callId: string) => new Promise<void>((r) => finished.set(callId, r));
let server: Server;
/** Replays run "as of" the original call date, so timeline maths match the transcript. */
let clock: Date | undefined;
let url: string;

beforeAll(async () => {
  server = createVaaniServer({
    core: { brain: rulesBrain(), bookingLink: calcomLink },
    store,
    actions: { telegram: quiet, email: quiet },
    token: TOKEN,
    now: () => clock ?? new Date(),
    onCallFinished: (id) => finished.get(id)?.(),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/vaani`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("Vaani protocol helpers", () => {
  it("takes only what the caller said since our last reply, dropping Vaani's duplicate lines", () => {
    expect(
      newCallerText([
        { role: "system", content: "x" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "What is this call regarding?" },
        { role: "user", content: "What is this call regarding?" },
      ]),
    ).toBe("What is this call regarding?");
    expect(newCallerText([{ role: "assistant", content: "A" }, { role: "user", content: "one" }, { role: "assistant", content: "B" }, { role: "user", content: "two" }])).toBe("two");
    expect(vaaniGreeting([{ role: "system", content: "x" }, { role: "assistant", content: "Namaste!" }, { role: "user", content: "hi" }])).toBe("Namaste!");
  });

  it("parses Vaani's documented webhook payloads", () => {
    expect(parseVaaniEvent({ event: "call_started", room_name: "r1", status: "dialing", phone_number: "+911234567890" })).toEqual({ kind: "started", callId: "r1", callerNumber: "+911234567890" });
    expect(parseVaaniEvent({ event: "call_ended", room_name: "r1", call_duration: 42.5, end_reason: "AGENT_REQUESTED_DISCONNECT" })).toMatchObject({ kind: "ended", durationSec: 42.5 });
    expect(parseVaaniEvent({ event: "call_postprocessing", call_id: "r1", data: { room_name: "r1" } })).toMatchObject({ kind: "postprocessed", callId: "r1" });
  });
});

describe("Vaani call server (BYOL WebSocket)", () => {
  it("refuses call connections without the bearer token", async () => {
    await expect(fakeVaaniCall({ url, callId: "no-auth", callerLines: ["hi"] })).rejects.toThrow(/401/);
  });

  it("lets Vaani's browser 'Test Connection' (bare URL, no token) see the handshake, but never runs the agent", async () => {
    const { WebSocket } = await import("ws");
    const frames: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on("message", (m) => {
        frames.push(JSON.parse(m.toString()));
        if (frames.length === 2) ws.send(JSON.stringify({ interaction_type: "response_required", response_id: 1, transcript: [{ role: "user", content: "how much per sq ft?" }] }));
      });
      ws.on("close", () => resolve());
      ws.on("error", reject);
    });
    expect(frames.map((f) => f.interaction_type)).toEqual(["config", "greeting"]);
    expect(frames.some((f) => f.response_type === "response")).toBe(false);
  });

  it("T13 over the wire: handshake, exact deflection twice, booked, caller number from call_started", async () => {
    const t13 = loadFixtures().find((f) => f.id === "T13")!;
    await handleVaaniEvent(parseVaaniEvent({ event: "call_started", room_name: "call-T13", phone_number: "+919822011313" }), { core: { brain: rulesBrain(), bookingLink: calcomLink }, store });
    const finishedT13 = done("call-T13");
    const r = await fakeVaaniCall({ url, callId: "call-T13", token: TOKEN, callerLines: t13.turns.filter((t) => t.speaker === "caller").map((t) => t.text) });
    await finishedT13;

    expect(r.handshake.map((f) => f.interaction_type)).toEqual(["config", "greeting"]);
    expect(r.replies[0]).toBe(PRICING_DEFLECTION);
    expect(r.replies[1]).toBe(PRICING_DEFLECTION);
    const result = store.results.get("call-T13")!;
    expect(result.outcome.kind).toBe("QUALIFIED");
    expect(result.enquiry.caller.number).toBe("+919822011313");
    expect(result.transcript[0]).toMatchObject({ speaker: "agent", action: "greet" }); // Vaani's own welcome line
    expect(store.bookings.some((b) => b.enquiryId === "call-T13")).toBe(true);
  });

  it("every September call gets its labelled outcome through the voice path, and no reply carries a price", async () => {
    for (const f of loadFixtures().filter((x) => x.status === "answered")) {
      const callId = `call-${f.id}-replay`;
      clock = new Date(f.receivedAt);
      const finishedCall = done(callId);
      const r = await fakeVaaniCall({ url, callId, token: TOKEN, callerLines: f.turns.filter((t) => t.speaker === "caller").map((t) => t.text) });
      await finishedCall;
      for (const reply of r.replies) expect(findPricingViolations(reply), `${f.id}: ${reply}`).toEqual([]);
      const result = store.results.get(callId)!;
      expect(result.outcome.kind, f.id).toBe(f.expected.outcome);
      if (f.expected.declineReason) expect(result.outcome.declineReason, f.id).toBe(f.expected.declineReason);
    }
    clock = undefined;
  }, 60000);

  it("a connection with no caller turn (Vaani's Test Connection) is not logged as a call", async () => {
    const finishedProbe = done("probe-1");
    await fakeVaaniCall({ url, callId: "probe-1", token: TOKEN, callerLines: [] });
    await finishedProbe;
    expect(store.results.has("probe-1")).toBe(false);
  });

  it("a silent call is then caught by the post-call webhook and becomes a callback", async () => {
    const deps = { core: { brain: rulesBrain(), bookingLink: calcomLink }, store, actions: { telegram: quiet, email: quiet } };
    await handleVaaniEvent(parseVaaniEvent({ event: "call_started", room_name: "silent-1", phone_number: "+919000000001" }), deps);
    const finishedSilent = done("silent-1");
    await fakeVaaniCall({ url, callId: "silent-1", token: TOKEN, callerLines: [] });
    await finishedSilent;
    await handleVaaniEvent(parseVaaniEvent({ event: "call_postprocessing", call_id: "silent-1" }), deps);
    expect(store.results.get("silent-1")!.outcome.kind).toBe("CALLBACK");
    expect((await store.pendingCallbacks()).some((c) => c.callerNumber === "+919000000001")).toBe(true);
  });
});

describe("Vaani webhooks (safety net)", () => {
  it("if the call server never handled a call, post-processing logs it as missed and queues a callback (T08)", async () => {
    const deps = { core: { brain: rulesBrain(), bookingLink: calcomLink }, store, actions: { telegram: quiet, email: quiet } };
    await handleVaaniEvent(parseVaaniEvent({ event: "call_started", room_name: "orphan-1", phone_number: "+919000000002" }), deps);
    const res = await handleVaaniEvent(parseVaaniEvent({ event: "call_postprocessing", call_id: "orphan-1", data: { room_name: "orphan-1" } }), deps);
    expect(res.action).toBe("queued_callback");
    expect(store.results.get("orphan-1")!.outcome.kind).toBe("CALLBACK");
  });

  it("does not double-log a call the server already finalised", async () => {
    const deps = { core: { brain: rulesBrain(), bookingLink: calcomLink }, store };
    expect((await handleVaaniEvent(parseVaaniEvent({ event: "call_postprocessing", call_id: "call-T13" }), deps)).action).toBe("already_handled");
  });
});
