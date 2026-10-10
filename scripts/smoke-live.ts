// End-to-end smoke test against the LIVE brain + store: one simulated Vaani call (T13's
// caller lines) over a real local WebSocket → call server → Gemini → guardrail → Supabase.
// Telegram/email are stubbed so nobody is messaged. Usage: npx tsx scripts/smoke-live.ts
import "@/cli/env";
import type { AddressInfo } from "node:net";
import { calcomLink } from "@/adapters/booking/calcom";
import { createBrain } from "@/adapters/brain";
import type { Transport } from "@/adapters/handoff/telegram";
import { createVaaniServer } from "@/server/vaani-ws";
import { getStore } from "@/store";
import { fakeVaaniCall } from "@/tests/support/fake-vaani";
import { loadFixtures } from "@/tests/support/fixtures";

const stub: Transport = { send: async () => ({ status: "stubbed" }) };

(async () => {
  const store = await getStore();
  const callId = `smoke-${Date.now()}`;
  let finished!: () => void;
  const done = new Promise<void>((r) => (finished = r));
  const server = createVaaniServer({ core: { brain: await createBrain(), bookingLink: calcomLink }, store, actions: { telegram: stub, email: stub }, token: "smoke", onCallFinished: () => finished() });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/vaani`;
  await store.noteCallStarted(callId, "+91 90000 99999", new Date().toISOString());
  const lines = loadFixtures().find((f) => f.id === "T13")!.turns.filter((t) => t.speaker === "caller").map((t) => t.text);
  const r = await fakeVaaniCall({ url, callId, token: "smoke", callerLines: lines });
  lines.forEach((l, i) => console.log(`Caller: ${l}\nAgent:  ${r.replies[i]}`));
  await done;
  const row = (await store.dashboardRows()).find((x) => x.id === callId);
  console.log("\nStored:", JSON.stringify(row, null, 2));
  server.close();
})();
