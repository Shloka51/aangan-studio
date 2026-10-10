// Decides what the agent does next. The model only words the reply; it never
// decides to book, decline or escalate.
import type { AgentAction, AgentActionKind, Facts, Qualification } from "./types";

export interface PolicyState {
  asked: AgentActionKind[]; // every action already taken
  lastCallerText: string;
}

const AFFIRM = /\b(yes|yeah|yep|sure|please|ok(ay)?|fine|let'?s (book|do)|book (it|that|now)|go ahead|haan|ha ji|theek hai|bilkul|zaroor|confirm)\b/i;

export function decideNext(f: Facts, q: Qualification, s: PolicyState): AgentAction {
  const did = (k: AgentActionKind) => s.asked.includes(k);

  // (c) Existing-project complaint: escalate, never sell.
  if (f.intents.complaint) return { kind: did("escalate") ? "acknowledge" : "escalate" };

  // Pricing: the scripted deflection, every time it is asked.
  if (f.intents.pricingAsked) return { kind: "deflect_pricing" };

  // Lead we dropped before: apologise first, then book directly.
  if (f.intents.priorFollowUpFailure && !did("recover_apology")) return { kind: "recover_apology" };

  // (b) Any hard fail: decline (or offer a later start for a timeline-only fail).
  if (q.failed.length) {
    const timelineOnly = q.declineReason === "impossible_timeline";
    if (timelineOnly && did("offer_deferred_start")) return { kind: "acknowledge", declineReason: q.declineReason };
    if (timelineOnly && f.intents.deferAfterEvent) return { kind: "offer_deferred_start", declineReason: q.declineReason };
    if (did("decline")) return { kind: "acknowledge", declineReason: q.declineReason };
    return { kind: "decline", declineReason: q.declineReason };
  }

  if (!f.intents.priorFollowUpFailure) {
    // Unclear on 1/2/3: one direct question each, never repeated.
    const c = (id: number) => q.criteria.find((x) => x.id === id)!.status === "UNCERTAIN";
    if (c(1) && !did("ask_scope")) return { kind: "ask_scope" };
    if (c(2) && !did("ask_location")) return { kind: "ask_location" };
    if (c(3) && !did("ask_timeline")) return { kind: "ask_timeline" };
  }

  // (a) Qualified (or uncertain only after asking): book.
  if (did("confirm_booking")) return { kind: "acknowledge" };
  // Recovery: we already let this caller down once — book directly, no extra questions.
  if (f.intents.priorFollowUpFailure && did("recover_apology")) return { kind: "confirm_booking" };
  const offered = did("offer_booking") || did("deflect_pricing") || did("recover_apology");
  if (offered && AFFIRM.test(s.lastCallerText)) return { kind: "confirm_booking" };
  return { kind: "offer_booking" };
}
