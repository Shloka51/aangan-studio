// The Vaani adapter drives the same core as the harness. No telephony, no network.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calcomLink } from "@/adapters/booking/calcom";
import { rulesBrain } from "@/adapters/brain";
import type { Transport } from "@/adapters/handoff/telegram";
import { handleVoiceEvent, parseVaaniEvent, verifySignature, type VoiceDeps } from "@/adapters/voice/vaani";
import { PRICING_DEFLECTION } from "@/core/knowledge";
import { MemoryStore } from "@/store/memory";
import { loadFixtures } from "./support/fixtures";

const quiet: Transport = { send: async () => ({ status: "sent" }) };
const setup = (): VoiceDeps & { store: MemoryStore } => ({
  core: { brain: rulesBrain(), bookingLink: calcomLink },
  store: new MemoryStore(),
  actions: { telegram: quiet, email: quiet },
});
const ev = (body: Record<string, unknown>) => parseVaaniEvent({ timestamp: "2026-09-16T12:19:00+05:30", from: "+91 98220 11313", ...body });

describe("Vaani voice adapter", () => {
  it("T13 over the webhook: greets, deflects pricing, books, hands off", async () => {
    const d = setup();
    const t13 = loadFixtures().find((f) => f.id === "T13")!;
    const start = await handleVoiceEvent(ev({ event: "call.started", call_id: "c1" }), d);
    expect(start.reply).toMatch(/Aangan Studio/);
    const replies: string[] = [];
    for (const t of t13.turns.filter((t) => t.speaker === "caller")) replies.push((await handleVoiceEvent(ev({ event: "call.turn", call_id: "c1", text: t.text }), d)).reply!);
    expect(replies[0]).toBe(PRICING_DEFLECTION);
    expect(replies[1]).toBe(PRICING_DEFLECTION);
    await handleVoiceEvent(ev({ event: "call.ended", call_id: "c1", reason: "caller_hangup" }), d);
    const [row] = await d.store.dashboardRows();
    expect(row).toMatchObject({ outcome: "QUALIFIED", booked: true, channel: "phone", callerNumber: "+91 98220 11313" });
    expect(d.store.handoffs.some((h) => h.kind === "designer")).toBe(true);
  });

  it("a dropped call before any outcome queues a callback (T17 first call)", async () => {
    const d = setup();
    await handleVoiceEvent(ev({ event: "call.started", call_id: "c2" }), d);
    await handleVoiceEvent(ev({ event: "call.turn", call_id: "c2", text: "Hi, I wanted to inquire about —" }), d);
    await handleVoiceEvent(ev({ event: "call.ended", call_id: "c2", reason: "network_drop" }), d);
    expect((await d.store.dashboardRows())[0].outcome).toBe("CALLBACK");
    expect(await d.store.pendingCallbacks()).toHaveLength(1);
  });

  it("a missed call (T08) is logged with a callback", async () => {
    const d = setup();
    await handleVoiceEvent(ev({ event: "call.missed", call_id: "c3", timestamp: "2026-09-09T22:47:00+05:30" }), d);
    const [row] = await d.store.dashboardRows();
    expect(row).toMatchObject({ outcome: "CALLBACK", afterHours: true });
    expect(row.firstResponseAt).toBeUndefined();
  });

  it("turns after the call has ended are ignored", async () => {
    const d = setup();
    await handleVoiceEvent(ev({ event: "call.started", call_id: "c4" }), d);
    await handleVoiceEvent(ev({ event: "call.ended", call_id: "c4" }), d);
    expect(await handleVoiceEvent(ev({ event: "call.turn", call_id: "c4", text: "hello?" }), d)).toEqual({ reply: "", end_call: true });
  });

  it("verifies HMAC signatures", () => {
    const body = '{"event":"call.started","call_id":"x"}';
    const sig = createHmac("sha256", "s3cret").update(body).digest("hex");
    expect(verifySignature(body, sig, "s3cret")).toBe(true);
    expect(verifySignature(body, "00" + sig.slice(2), "s3cret")).toBe(false);
    expect(verifySignature(body, null, "s3cret")).toBe(false);
  });
});
