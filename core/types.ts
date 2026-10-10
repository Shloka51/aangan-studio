// Channel-agnostic types. Nothing in core/ knows about telephony, Telegram or Supabase.

export type Channel = "phone" | "whatsapp" | "web_form";

/** How the contact reached us. A phone adapter maps its call states onto this. */
export type ContactStatus = "answered" | "missed" | "dropped";

export type Speaker = "caller" | "agent";

export interface Turn {
  speaker: Speaker;
  text: string;
  at?: string; // ISO timestamp
  /** For agent turns: what the policy decided this turn was for. */
  action?: AgentActionKind;
  /** For agent turns: true when the pricing guardrail rewrote the model's output. */
  guardrail?: boolean;
}

/** The normalized input every adapter produces. */
export interface Enquiry {
  id: string;
  externalId?: string; // e.g. the voice provider's call id
  channel: Channel;
  caller: { name?: string; number?: string };
  receivedAt: string; // ISO
  status: ContactStatus;
  /** Caller turns to replay (text harness / tests), or [] for a live session. */
  turns: Turn[];
  meta?: Record<string, unknown>;
}

export type Language = "en" | "hinglish";

export type ProjectType = "full_home" | "partial" | "single_room" | "office";
export type Segment = "residential" | "commercial";

export type OutOfScopeKind =
  | "restaurant"
  | "hotel"
  | "retail"
  | "gym"
  | "architecture"
  | "vastu_only"
  | "furniture_only";

export type AreaStatus = "listed" | "adjoining" | "out" | "unknown";

export interface Facts {
  callerName?: string;
  language: Language;
  segment?: Segment;
  projectType?: ProjectType;
  property?: string; // "3BHK", "villa", "office", ...
  rooms: string[];
  location?: string;
  area: AreaStatus;
  sqft?: number;
  /** Criterion 1 signals. */
  wantsExecution?: boolean;
  adviceOnly?: boolean;
  outOfScope?: OutOfScopeKind;
  rented?: boolean;
  timeline: {
    deadlineRaw?: string;
    deadline?: string; // ISO date: must be complete by
    deadlineEvent?: string; // e.g. "Diwali"
    startRaw?: string;
    start?: string; // ISO date: wants to start from
    siteAvailable?: string; // ISO date: possession / site handover
    noRush?: boolean;
    urgent?: boolean;
  };
  decisionMaker: { status: "self" | "represented" | "unclear"; note?: string };
  budget?: { raw: string; maxInr?: number };
  referral?: string;
  intents: {
    pricingAsked: boolean; // in the latest caller turn
    complaint: boolean; // existing-project complaint
    priorFollowUpFailure: boolean; // "I called before, nobody got back"
    reconnect: boolean; // "I got cut off just now"
    deferAfterEvent?: boolean; // "what if I start after Diwali?"
  };
  siteVisitRequested?: boolean;
}

export type CriterionId = 1 | 2 | 3 | 4 | 5;
export type CriterionStatus = "PASS" | "FAIL" | "UNCERTAIN";

export interface CriterionResult {
  id: CriterionId;
  name: string;
  status: CriterionStatus;
  reason: string;
}

export type DeclineReason =
  | "out_of_area"
  | "advice_only"
  | "out_of_scope_type"
  | "below_min_commercial"
  | "above_max_commercial"
  | "budget_mismatch"
  | "impossible_timeline"
  | "multiple";

export interface Qualification {
  criteria: CriterionResult[];
  failed: CriterionId[];
  uncertain: CriterionId[];
  /** QUALIFIED = all pass; UNCERTAIN = none fail, some unclear; NOT_QUALIFIED = any fail. */
  verdict: "QUALIFIED" | "UNCERTAIN" | "NOT_QUALIFIED";
  declineReason?: DeclineReason;
}

export type OutcomeKind = "QUALIFIED" | "DECLINED" | "ESCALATED" | "CALLBACK";

export interface Outcome {
  kind: OutcomeKind;
  declineReason?: DeclineReason;
  /** A lead we previously failed to follow up on: book, and handle with care. */
  recovery?: boolean;
  /** Plain-language next step. Every outcome has one. */
  nextStep: string;
}

export type AgentActionKind =
  | "greet"
  | "ask_scope"
  | "ask_location"
  | "ask_timeline"
  | "ask_name"
  | "deflect_pricing"
  | "recover_apology"
  | "offer_booking"
  | "confirm_booking"
  | "decline"
  | "offer_deferred_start"
  | "escalate"
  | "acknowledge";

export interface AgentAction {
  kind: AgentActionKind;
  declineReason?: DeclineReason;
}

export interface HandoffNote {
  callerName: string;
  callerNumber: string;
  channel: Channel;
  timestamp: string; // IST, human readable
  projectType: string;
  location: string;
  inServiceArea: string;
  approxSizeSqft: string;
  scopeSummary: string;
  timeline: string;
  leadTimeCheck: string;
  decisionMaker: string;
  budgetNote?: string; // only if the caller volunteered a figure
  qualification: "QUALIFIED" | "UNCERTAIN";
  uncertainCriteria: string[];
  consultation: string;
  priority?: string; // e.g. recovery: handle with care
  transcript: string;
}

export type Action =
  | { type: "book_consultation"; url: string; callerNumber?: string }
  | { type: "send_handoff"; note: HandoffNote; text: string }
  | { type: "escalate"; to: "studio_head"; summary: string; callerNumber?: string; callbackWithinMinutes: number }
  | { type: "queue_callback"; callerNumber?: string; reason: string; dueBy: string }
  | { type: "resolve_callback"; callerNumber?: string }
  | { type: "schedule_followup"; callerNumber?: string; date: string; reason: string }
  | { type: "log_decline"; reason: DeclineReason };

export interface UsageRecord {
  provider: string; // "gemini" | "rules"
  model: string;
  purpose: "nlu" | "nlg";
  inputTokens: number;
  outputTokens: number;
  costInr: number;
}

export interface GuardrailEvent {
  turnIndex: number;
  original: string;
  replacement: string;
  reasons: string[];
}

export interface EnquiryResult {
  enquiry: Enquiry;
  facts: Facts;
  qualification: Qualification;
  outcome: Outcome;
  transcript: Turn[];
  handoffNote?: HandoffNote;
  actions: Action[];
  guardrailEvents: GuardrailEvent[];
  usage: UsageRecord[];
  firstResponseAt?: string;
  afterHours: boolean;
}
