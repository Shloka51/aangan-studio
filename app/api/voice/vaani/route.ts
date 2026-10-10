// Vaani call-event webhook (call_started, call_ended, call_postprocessing).
// Vaani's webhooks aren't signed, so the URL carries a secret: ?token=VAANI_WEBHOOK_SECRET.
// The live conversation itself goes to the WebSocket call server (server/vaani-ws.ts).
import { timingSafeEqual } from "node:crypto";
import { calcomLink } from "@/adapters/booking/calcom";
import { rulesBrain } from "@/adapters/brain";
import { handleVaaniEvent, parseVaaniEvent } from "@/adapters/voice/vaani";
import { getStore } from "@/store";

export const runtime = "nodejs";
export const maxDuration = 30;

function tokenOk(got: string | null): boolean {
  const want = process.env.VAANI_WEBHOOK_SECRET?.trim();
  if (!want) return process.env.NODE_ENV !== "production";
  const a = Buffer.from(got ?? ""), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!tokenOk(new URL(req.url).searchParams.get("token"))) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  // The missed-call path needs no model: classification is deterministic.
  const res = await handleVaaniEvent(parseVaaniEvent(body), { core: { brain: rulesBrain(), bookingLink: calcomLink }, store: await getStore() });
  return Response.json(res);
}
