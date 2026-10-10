// Loads dashboard rows. With Supabase configured, reads the live store. Without it,
// replays T01–T20 into an in-memory store so the page has something real to show
// (transports are stubbed: demo mode never messages anyone).
import { executeActions } from "@/adapters/actions";
import { calcomLink } from "@/adapters/booking/calcom";
import { rulesBrain } from "@/adapters/brain";
import type { Transport } from "@/adapters/handoff/telegram";
import { processEnquiry } from "@/core/session";
import type { Enquiry } from "@/core/types";
import fixtures from "@/tests/fixtures/transcripts.json";
import { getStore, type DashboardRow, type Store } from "@/store";
import { MemoryStore } from "@/store/memory";

const stub: Transport = { send: async () => ({ status: "stubbed" }) };

export async function replayFixtures(store: Store) {
  for (const f of fixtures) {
    const e: Enquiry = { id: f.id, channel: "phone", caller: f.caller, receivedAt: f.receivedAt, status: f.status as Enquiry["status"], turns: f.turns as Enquiry["turns"] };
    const r = await processEnquiry(e, { brain: rulesBrain(), bookingLink: calcomLink, clock: () => new Date(e.receivedAt) });
    await executeActions(r, { store, telegram: stub, email: stub });
  }
}

let demo: Promise<MemoryStore> | undefined;

export async function loadRows(): Promise<{ rows: DashboardRow[]; mode: "live" | "demo" }> {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { rows: await (await getStore()).dashboardRows(), mode: "live" };
  }
  demo ??= (async () => {
    const s = new MemoryStore();
    await replayFixtures(s);
    return s;
  })();
  return { rows: await (await demo).dashboardRows(), mode: "demo" };
}
