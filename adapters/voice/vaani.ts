// Vaani voice adapter (vaanivoice.ai). Vaani does telephony + STT + TTS (Hindi/English).
// Two integration points, both from Vaani's docs (docs.vaanivoice.ai):
//
// 1. "Bring Your Own LLM" WebSocket (guides/byol). Vaani opens one WebSocket per call at
//    <our-url>/<call_id>. We must send a `config` and a `greeting` frame on connect. For
//    every caller turn Vaani sends `response_required` with the full transcript; we answer
//    with `response` frames echoing `response_id`, `content_complete: true` on the last
//    one, and optionally `end_call: true`. We send the whole reply in one frame because
//    the pricing guardrail must see the complete text before anything is spoken.
//
// 2. Call-event webhooks (guides/webhook-setup): `call_started`, `call_ended`,
//    `call_postprocessing`, etc., as plain HTTP POSTs (handled on Vercel).
//
// Everything Vaani-specific lives in this file; the core never sees a Vaani field.
import { executeActions, type ActionDeps } from "@/adapters/actions";
import { Session, type CoreDeps } from "@/core/session";
import type { Enquiry, EnquiryResult } from "@/core/types";
import type { Store } from "@/store";

export interface VaaniMessage {
  role: "system" | "assistant" | "user" | string;
  content: string;
}

export interface VaaniRequest {
  interaction_type: string;
  response_id?: number;
  call_id?: string;
  transcript?: VaaniMessage[];
  req_body?: { contact_number?: string; name?: string } | null;
}

export type VaaniFrame = Record<string, unknown>;

export interface VoiceDeps {
  core: CoreDeps;
  store: Store;
  actions?: Omit<ActionDeps, "store">;
  now?: () => Date;
}

/** Frames Vaani requires right after the WebSocket is accepted (contents are ignored). */
export function handshakeFrames(): VaaniFrame[] {
  return [
    { interaction_type: "config", content: "Aangan Studio agent ready" },
    { interaction_type: "greeting", content: "Hello" },
  ];
}

/** What the caller said since our last reply. Vaani may repeat a user line; drop exact repeats. */
export function newCallerText(transcript: VaaniMessage[] = []): string {
  const lastAssistant = transcript.map((m) => m.role).lastIndexOf("assistant");
  const lines: string[] = [];
  for (const m of transcript.slice(lastAssistant + 1)) {
    const t = (m.content ?? "").trim();
    if (m.role === "user" && t && t !== lines.at(-1)) lines.push(t);
  }
  return lines.join(" ");
}

/** Vaani speaks its own configured welcome line before calling us; it's the first assistant message. */
export function vaaniGreeting(transcript: VaaniMessage[] = []): string | undefined {
  const firstUser = transcript.findIndex((m) => m.role === "user");
  return transcript.slice(0, firstUser < 0 ? undefined : firstUser).find((m) => m.role === "assistant")?.content?.trim() || undefined;
}

const TERMINAL = new Set(["confirm_booking", "decline", "offer_deferred_start", "escalate"]);

/** One live call. Feed it Vaani frames; it returns the frames to send back. */
export class VaaniCall {
  private session?: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private finalized?: Promise<EnquiryResult | undefined>;

  constructor(
    readonly callId: string,
    private deps: VoiceDeps,
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async ensureSession(req?: VaaniRequest): Promise<Session> {
    if (this.session) return this.session;
    const number = req?.req_body?.contact_number || (await this.deps.store.callerNumberFor(this.callId).catch(() => undefined));
    const enquiry: Enquiry = {
      id: this.callId,
      externalId: this.callId,
      channel: "phone",
      caller: { number, name: req?.req_body?.name || undefined },
      receivedAt: this.now().toISOString(),
      status: "answered",
      turns: [],
    };
    this.session = Session.start(enquiry, { ...this.deps.core, clock: this.deps.now ?? this.deps.core.clock });
    return this.session;
  }

  /** Frames are processed strictly in order, one turn at a time. */
  onFrame(msg: VaaniRequest): Promise<VaaniFrame[]> {
    const run = this.queue.then(() => this.handle(msg));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async handle(msg: VaaniRequest): Promise<VaaniFrame[]> {
    if (msg.interaction_type !== "response_required" && msg.interaction_type !== "reminder_required") return [];
    const responseId = msg.response_id ?? 0;
    const session = await this.ensureSession(msg);
    if (!session.state.transcript.length) {
      const greeting = vaaniGreeting(msg.transcript);
      if (greeting) session.noteAgentSaid(greeting);
    }
    const text = newCallerText(msg.transcript);
    if (!text) return [{ response_type: "response", response_id: responseId, content: "", content_complete: true }];

    const turn = await session.onCallerTurn(text);
    await this.deps.store.saveSession(session.state).catch((err) => console.warn("[vaani] saveSession failed:", (err as Error).message));
    const alreadyClosed = session.state.transcript.slice(0, -1).some((t) => t.action && TERMINAL.has(t.action));
    const endCall = turn.action.kind === "acknowledge" && alreadyClosed;
    return [{ response_type: "response", response_id: responseId, content: turn.reply, content_complete: true, ...(endCall ? { end_call: true } : {}) }];
  }

  /**
   * Call over (WebSocket closed): classify, store, hand off. Safe to call more than once.
   * A connection that never carried a caller turn (Vaani's "Test Connection", or a caller
   * who said nothing) is not finalised here: Vaani's call_postprocessing webhook logs
   * real silent calls as missed and queues the callback.
   */
  onClose(): Promise<EnquiryResult | undefined> {
    this.finalized ??= this.queue.then(async () => {
      if (!this.session) return undefined;
      const session = this.session;
      const e = session.state.enquiry;
      e.caller.number ??= await this.deps.store.callerNumberFor(this.callId).catch(() => undefined);
      if (!session.state.transcript.some((t) => t.speaker === "caller")) e.status = "dropped";
      const result = session.finalize();
      await this.deps.store.saveSession(session.state).catch(() => undefined);
      await executeActions(result, { store: this.deps.store, ...this.deps.actions });
      return result;
    });
    return this.finalized;
  }
}

// ---- Call-event webhooks -------------------------------------------------------------

export type VaaniEvent =
  | { kind: "started"; callId: string; callerNumber?: string }
  | { kind: "ended"; callId: string; endReason?: string; durationSec?: number }
  | { kind: "postprocessed"; callId: string; callerNumber?: string }
  | { kind: "other"; callId?: string; event: string };

export function parseVaaniEvent(body: Record<string, unknown>): VaaniEvent {
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Record<string, unknown>;
  const str = (...vals: unknown[]) => vals.find((v): v is string => typeof v === "string" && v.length > 0);
  const callId = str(body.room_name, body.call_id, data.room_name, data.call_id);
  const callerNumber = str(body.phone_number, body.caller_number, body.from, data.phone_number, data.contact_number, data.caller_number);
  const event = String(body.event ?? "");
  if (!callId) return { kind: "other", event };
  if (event === "call_started" || event === "user_picked_up_at") return { kind: "started", callId, callerNumber };
  if (event === "call_ended") return { kind: "ended", callId, endReason: str(body.end_reason), durationSec: typeof body.call_duration === "number" ? body.call_duration : undefined };
  if (event === "call_postprocessing") return { kind: "postprocessed", callId, callerNumber };
  return { kind: "other", callId, event };
}

/**
 * Webhook side. `call_started` records the caller's number for the WebSocket session.
 * `call_postprocessing` is the safety net: if our call server never finalised this call
 * (it was unreachable, so the caller heard nothing useful), log it as a missed call and
 * queue a callback, exactly like T08.
 */
export async function handleVaaniEvent(ev: VaaniEvent, deps: VoiceDeps): Promise<{ ok: true; action: string }> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  if (ev.kind === "started") {
    await deps.store.noteCallStarted(ev.callId, ev.callerNumber, at);
    return { ok: true, action: "noted_caller" };
  }
  if (ev.kind === "postprocessed") {
    if (await deps.store.isCompleted(ev.callId)) return { ok: true, action: "already_handled" };
    const number = ev.callerNumber ?? (await deps.store.callerNumberFor(ev.callId));
    const missed = Session.start(
      { id: ev.callId, externalId: ev.callId, channel: "phone", caller: { number }, receivedAt: at, status: "missed", turns: [] },
      deps.core,
    ).finalize();
    await executeActions(missed, { store: deps.store, ...deps.actions });
    return { ok: true, action: "queued_callback" };
  }
  return { ok: true, action: "ignored" };
}
