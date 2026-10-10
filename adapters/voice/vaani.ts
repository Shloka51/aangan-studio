// Vaani voice adapter. Vaani does telephony + STT + TTS (Hindi/English); per caller
// utterance it calls our webhook, we run the core (Gemini + guardrail) and return the
// text for Vaani to speak.
//
// ASSUMED CONTRACT — confirm against Vaani's docs. Only `parseVaaniEvent` and
// `toVaaniResponse` know Vaani's field names; everything else is channel-agnostic.
//   { event: "call.started", call_id, from, to?, timestamp? }          → { reply }
//   { event: "call.turn",    call_id, from, text, language?, timestamp? } → { reply, end_call }
//   { event: "call.ended",   call_id, from, reason, timestamp? }        → { ok }
//   { event: "call.missed",  call_id, from, timestamp? }                → { ok }
// Signature: header `x-vaani-signature` = hex HMAC-SHA256(rawBody, VAANI_WEBHOOK_SECRET).
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { executeActions, type ActionDeps } from "@/adapters/actions";
import { Session, type CoreDeps } from "@/core/session";
import type { Store } from "@/store";

export type VoiceEvent =
  | { kind: "started"; callId: string; from?: string; at: string }
  | { kind: "turn"; callId: string; from?: string; text: string; at: string }
  | { kind: "ended"; callId: string; from?: string; reason: "completed" | "caller_hangup" | "dropped"; at: string }
  | { kind: "missed"; callId: string; from?: string; at: string };

export function verifySignature(rawBody: string, signature: string | null, secret = process.env.VAANI_WEBHOOK_SECRET): boolean {
  if (!secret) return process.env.NODE_ENV !== "production"; // dev/test only
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(signature.replace(/^sha256=/, ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseVaaniEvent(body: Record<string, unknown>): VoiceEvent {
  const s = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const callId = s("call_id") ?? s("callId");
  if (!callId) throw new Error("vaani: missing call_id");
  const from = s("from") ?? s("caller_number");
  const at = s("timestamp") ?? new Date().toISOString();
  switch (s("event")) {
    case "call.started":
      return { kind: "started", callId, from, at };
    case "call.turn":
    case "transcript":
      return { kind: "turn", callId, from, text: s("text") ?? s("transcript") ?? "", at };
    case "call.ended": {
      const r = s("reason") ?? "completed";
      const reason = /drop|network|disconnect|error|fail/i.test(r) ? "dropped" : /hang/i.test(r) ? "caller_hangup" : "completed";
      return { kind: "ended", callId, from, reason, at };
    }
    case "call.missed":
    case "call.no_answer":
      return { kind: "missed", callId, from, at };
    default:
      throw new Error(`vaani: unknown event ${String(body.event)}`);
  }
}

export interface VoiceDeps {
  core: CoreDeps;
  store: Store;
  actions?: Omit<ActionDeps, "store">;
}

export interface VoiceResponse {
  reply?: string;
  end_call?: boolean;
  ok?: boolean;
}

function newEnquiry(ev: VoiceEvent, status: "answered" | "missed") {
  return { id: randomUUID(), externalId: ev.callId, channel: "phone" as const, caller: { number: ev.from }, receivedAt: ev.at, status, turns: [] };
}

/** Framework-agnostic webhook handler: one Vaani event in, one response out. */
export async function handleVoiceEvent(ev: VoiceEvent, deps: VoiceDeps): Promise<VoiceResponse> {
  const { store } = deps;

  if (ev.kind === "missed") {
    const s = Session.start(newEnquiry(ev, "missed"), deps.core);
    await executeActions(s.finalize(), { store, ...deps.actions });
    return { ok: true };
  }

  if (ev.kind === "started") {
    const s = Session.start(newEnquiry(ev, "answered"), deps.core);
    const reply = await s.greet();
    await store.saveSession(s.state);
    return { reply };
  }

  const state = await store.loadSessionByExternalId(ev.callId);
  if (!state) {
    // Turn for a call we never saw start (e.g. a cold webhook): start one now.
    if (ev.kind === "ended") return { ok: true };
    await handleVoiceEvent({ kind: "started", callId: ev.callId, from: ev.from, at: ev.at }, deps);
    return handleVoiceEvent(ev, deps);
  }
  if (state.ended) return ev.kind === "turn" ? { reply: "", end_call: true } : { ok: true };
  const s = new Session(state, deps.core);

  if (ev.kind === "turn") {
    const t = await s.onCallerTurn(ev.text);
    await store.saveSession(s.state);
    return { reply: t.reply, end_call: t.action.kind === "acknowledge" && t.terminal };
  }

  // ended
  const terminalReached = s.state.transcript.some((t) => t.action && ["confirm_booking", "decline", "offer_deferred_start", "escalate"].includes(t.action));
  if (ev.reason === "dropped" && !terminalReached) s.state.enquiry.status = "dropped";
  const result = s.finalize();
  await store.saveSession(s.state);
  await executeActions(result, { store, ...deps.actions });
  return { ok: true };
}

export function toVaaniResponse(r: VoiceResponse) {
  return r; // { reply, end_call } — rename here if Vaani expects other keys.
}
