// Vaani webhook endpoint. Thin: verify, parse, hand to the channel-agnostic handler.
import { calcomLink } from "@/adapters/booking/calcom";
import { createBrain } from "@/adapters/brain";
import { handleVoiceEvent, parseVaaniEvent, toVaaniResponse, verifySignature } from "@/adapters/voice/vaani";
import { getStore } from "@/store";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-vaani-signature"))) return Response.json({ error: "bad signature" }, { status: 401 });
  let ev;
  try {
    ev = parseVaaniEvent(JSON.parse(raw));
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
  const res = await handleVoiceEvent(ev, { core: { brain: await createBrain(), bookingLink: calcomLink }, store: await getStore() });
  return Response.json(toVaaniResponse(res));
}
