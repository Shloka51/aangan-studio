// End-to-end smoke test against the LIVE store and brain: one simulated phone call
// (T13's caller lines) through the Vaani handler → Gemini → guardrail → Supabase.
// Telegram/email are stubbed so nobody is messaged. Usage: npx tsx scripts/smoke-live.ts
import "@/cli/env";
import { calcomLink } from "@/adapters/booking/calcom";
import { createBrain } from "@/adapters/brain";
import type { Transport } from "@/adapters/handoff/telegram";
import { handleVoiceEvent, parseVaaniEvent } from "@/adapters/voice/vaani";
import { getStore } from "@/store";
import { loadFixtures } from "@/tests/support/fixtures";

const stub: Transport = { send: async () => ({ status: "stubbed" }) };

(async () => {
  const store = await getStore();
  const brain = await createBrain();
  const callId = `smoke-${Date.now()}`;
  const at = new Date().toISOString();
  const ev = (b: Record<string, unknown>) => parseVaaniEvent({ call_id: callId, from: "+91 90000 99999", timestamp: at, ...b });
  const deps = { core: { brain, bookingLink: calcomLink }, store, actions: { telegram: stub, email: stub } };

  console.log("Agent:", (await handleVoiceEvent(ev({ event: "call.started" }), deps)).reply);
  for (const t of loadFixtures().find((f) => f.id === "T13")!.turns.filter((t) => t.speaker === "caller")) {
    console.log("Caller:", t.text);
    console.log("Agent:", (await handleVoiceEvent(ev({ event: "call.turn", text: t.text }), deps)).reply);
  }
  await handleVoiceEvent(ev({ event: "call.ended", reason: "caller_hangup" }), deps);
  const row = (await store.dashboardRows()).find((r) => r.callerNumber === "+91 90000 99999" && r.receivedAt.slice(0, 19) === at.slice(0, 19));
  console.log("\nStored:", JSON.stringify(row, null, 2));
})();
