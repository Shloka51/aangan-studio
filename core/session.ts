// The pipeline: load context → converse/qualify → pricing guardrail → classify outcome
// → build handoff note → emit actions. Channel-agnostic; state is plain JSON so a
// stateless webhook can persist it between turns.
import { STUDIO } from "./config";
import { enforcePricingGuardrail } from "./guardrail";
import { buildHandoffNote, renderHandoffText } from "./handoff";
import type { NLG } from "./nlg";
import { cleanUtterance, emptyFacts, type NLU } from "./nlu";
import { decideNext } from "./policy";
import { qualify } from "./qualify";
import type { Action, AgentAction, Enquiry, EnquiryResult, Facts, GuardrailEvent, Outcome, Qualification, Turn, UsageRecord } from "./types";

export interface Brain {
  nlu: NLU;
  nlg: NLG;
}

export interface CoreDeps {
  brain: Brain;
  /** Builds a booking link for a qualified caller (adapters/booking). */
  bookingLink: (input: { name?: string; number?: string; notes: string }) => string;
  clock?: () => Date;
}

export interface SessionState {
  enquiry: Enquiry;
  transcript: Turn[];
  facts: Facts;
  guardrailEvents: GuardrailEvent[];
  usage: UsageRecord[];
  firstResponseAt?: string;
  ended?: boolean;
}

export interface TurnResult {
  reply: string;
  action: AgentAction;
  /** True when the conversation has reached a terminal step (booked/declined/escalated). */
  terminal: boolean;
}

const TERMINAL = new Set(["confirm_booking", "decline", "offer_deferred_start", "escalate"]);

export function isAfterHours(iso: string): boolean {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: STUDIO.timezone, weekday: "short", hour: "numeric", hour12: false }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")!.value) % 24;
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);
  const { startHour, endHour, days } = STUDIO.businessHours;
  return !days.includes(day) || hour < startHour || hour >= endHour;
}

export class Session {
  constructor(
    public state: SessionState,
    private deps: CoreDeps,
  ) {}

  static start(enquiry: Enquiry, deps: CoreDeps): Session {
    return new Session({ enquiry, transcript: [], facts: emptyFacts(), guardrailEvents: [], usage: [] }, deps);
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  /** "Reference time" for timeline maths: when the enquiry arrived. */
  private get refDate(): Date {
    return new Date(this.state.enquiry.receivedAt);
  }

  private qualification(): Qualification {
    return qualify(this.state.facts, { now: this.refDate });
  }

  private async say(action: AgentAction): Promise<string> {
    const s = this.state;
    const notes = `${s.facts.projectType ?? "project"} in ${s.facts.location ?? "Pune"}`;
    const bookingUrl = action.kind === "confirm_booking" ? this.deps.bookingLink({ name: s.facts.callerName, number: s.enquiry.caller.number, notes }) : undefined;
    let candidate: string;
    try {
      const out = await this.deps.brain.nlg.render({ action, facts: s.facts, bookingUrl });
      candidate = out.text;
      if (out.usage) s.usage.push(out.usage);
    } catch {
      const { renderTemplate } = await import("./nlg");
      candidate = renderTemplate({ action, facts: s.facts, bookingUrl });
    }
    const g = enforcePricingGuardrail(candidate, { callerAskedPricing: s.facts.intents.pricingAsked, language: s.facts.language });
    if (g.rewritten) s.guardrailEvents.push({ turnIndex: s.transcript.length, original: candidate, replacement: g.text, reasons: g.reasons });
    s.transcript.push({ speaker: "agent", text: g.text, at: this.now().toISOString(), action: action.kind, guardrail: g.rewritten || undefined });
    s.firstResponseAt ??= this.now().toISOString();
    return g.text;
  }

  /** The agent's opening line (live calls). */
  async greet(): Promise<string> {
    return this.say({ kind: "greet" });
  }

  async onCallerTurn(text: string): Promise<TurnResult> {
    const s = this.state;
    const clean = cleanUtterance(text);
    s.transcript.push({ speaker: "caller", text: clean, at: this.now().toISOString() });
    const { facts, usage } = await this.deps.brain.nlu.extract({ transcript: s.transcript, now: this.refDate, known: { callerName: s.enquiry.caller.name } });
    s.facts = facts;
    if (usage) s.usage.push(usage);
    const q = this.qualification();
    const action = decideNext(facts, q, {
      asked: s.transcript.filter((t) => t.speaker === "agent" && t.action).map((t) => t.action!),
      lastCallerText: clean,
    });
    const reply = await this.say(action);
    return { reply, action, terminal: TERMINAL.has(action.kind) };
  }

  /** Classify the outcome and emit actions. Call once when the call/thread ends. */
  finalize(): EnquiryResult {
    const s = this.state;
    s.ended = true;
    const e = s.enquiry;
    const f = s.facts;
    const q = this.qualification();
    const number = e.caller.number;
    const outcome = classify(e, f, q, s.transcript);
    const actions: Action[] = [];
    let handoffNote;

    if (f.intents.reconnect) actions.push({ type: "resolve_callback", callerNumber: number });

    switch (outcome.kind) {
      case "CALLBACK": {
        const due = new Date(Math.max(this.now().getTime(), nextBusinessOpen(this.now()).getTime()) + STUDIO.callbackMinutes * 60_000);
        actions.push({ type: "queue_callback", callerNumber: number, reason: e.status === "missed" ? "Missed call — no conversation" : e.status === "dropped" ? "Call disconnected before details were captured" : "Call ended before the enquiry was clear", dueBy: due.toISOString() });
        break;
      }
      case "ESCALATED":
        actions.push({
          type: "escalate",
          to: "studio_head",
          summary: `Existing-project complaint from ${f.callerName ?? "caller"} (${number ?? "number unknown"}). Wants a callback from Nikhil or a senior person.\n\n${s.transcript.filter((t) => t.speaker === "caller").map((t) => t.text).join(" ")}`,
          callerNumber: number,
          callbackWithinMinutes: STUDIO.escalationCallbackMinutes,
        });
        break;
      case "DECLINED":
        actions.push({ type: "log_decline", reason: outcome.declineReason! });
        if (outcome.declineReason === "impossible_timeline" && f.timeline.start)
          actions.push({ type: "schedule_followup", callerNumber: number, date: f.timeline.start, reason: `Caller open to starting after ${f.timeline.deadlineEvent ?? "their deadline"} — call to book` });
        break;
      case "QUALIFIED": {
        const url = this.deps.bookingLink({ name: f.callerName, number, notes: `${f.projectType ?? "project"} in ${f.location ?? "Pune"}` });
        actions.push({ type: "book_consultation", url, callerNumber: number });
        handoffNote = buildHandoffNote(e, f, q, outcome, s.transcript, url);
        actions.push({ type: "send_handoff", note: handoffNote, text: renderHandoffText(handoffNote) });
        break;
      }
    }

    return {
      enquiry: e,
      facts: f,
      qualification: q,
      outcome,
      transcript: s.transcript,
      handoffNote,
      actions,
      guardrailEvents: s.guardrailEvents,
      usage: s.usage,
      firstResponseAt: s.firstResponseAt,
      afterHours: isAfterHours(e.receivedAt),
    };
  }
}

export function nextBusinessOpen(from: Date): Date {
  const d = new Date(from);
  for (let i = 0; i < 4 * 24 * 8 && isAfterHours(d.toISOString()); i++) d.setTime(d.getTime() + 15 * 60_000);
  return d;
}

export function classify(e: Enquiry, f: Facts, q: Qualification, transcript: Turn[]): Outcome {
  if (e.status === "missed") return { kind: "CALLBACK", nextStep: "Call the number back at the next opportunity and log the enquiry." };
  if (f.intents.complaint)
    return { kind: "ESCALATED", nextStep: `Studio head (Nikhil) or a senior person calls back within ${STUDIO.escalationCallbackMinutes} minutes.` };
  const callerSaidLittle = transcript.filter((t) => t.speaker === "caller").map((t) => t.text).join(" ").split(/\s+/).length < 12;
  const nothingKnown = q.criteria[0].status === "UNCERTAIN" && q.criteria[1].status === "UNCERTAIN";
  if (e.status === "dropped" || (nothingKnown && callerSaidLittle))
    return { kind: "CALLBACK", nextStep: "Call the number back to complete the enquiry." };
  if (q.failed.length) {
    const deferred = q.declineReason === "impossible_timeline" && f.timeline.start;
    return {
      kind: "DECLINED",
      declineReason: q.declineReason,
      nextStep: deferred ? `Follow up to book for a start after ${f.timeline.deadlineEvent ?? "their deadline"}.` : "Declined politely; caller told they're welcome to reach out if scope/area/timeline changes.",
    };
  }
  return {
    kind: "QUALIFIED",
    recovery: f.intents.priorFollowUpFailure || undefined,
    nextStep: f.intents.priorFollowUpFailure ? "Consultation booked directly; designer to reach out same day — handle with care." : "Booking link sent; designer receives handoff note.",
  };
}

/** Replays an enquiry's caller turns through a fresh session (text harness + tests). */
export async function processEnquiry(e: Enquiry, deps: CoreDeps): Promise<EnquiryResult> {
  const session = Session.start({ ...e, turns: [] }, deps);
  if (e.status !== "missed") {
    for (const t of e.turns.filter((t) => t.speaker === "caller")) await session.onCallerTurn(t.text);
  }
  const r = session.finalize();
  return { ...r, enquiry: e };
}
