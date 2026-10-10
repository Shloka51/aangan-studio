// Persistence port. The core never imports this; adapters and the dashboard do.
import type { SessionState } from "@/core/session";
import type { EnquiryResult, HandoffNote } from "@/core/types";

export interface HandoffRecord {
  enquiryId: string;
  kind: "designer" | "escalation" | "callback_alert";
  channel: "telegram" | "email";
  status: "sent" | "failed" | "stubbed";
  note?: HandoffNote;
  body: string;
  error?: string;
}

export interface CallbackRecord {
  enquiryId?: string;
  callerNumber?: string;
  kind: "callback" | "followup";
  reason: string;
  dueBy: string;
}

/** One row per enquiry, already joined, for the dashboard. */
export interface DashboardRow {
  id: string;
  channel: string;
  callerName?: string;
  callerNumber?: string;
  receivedAt: string;
  firstResponseAt?: string;
  outcome?: string;
  declineReason?: string;
  recovery: boolean;
  afterHours: boolean;
  qualification?: "QUALIFIED" | "UNCERTAIN" | "NOT_QUALIFIED";
  booked: boolean;
  costInr: number;
  tokens: number;
}

export interface Store {
  saveSession(state: SessionState): Promise<void>;
  loadSessionByExternalId(externalId: string): Promise<SessionState | null>;
  saveResult(r: EnquiryResult): Promise<void>;
  recordHandoff(h: HandoffRecord): Promise<void>;
  recordBooking(enquiryId: string, url: string): Promise<void>;
  queueCallback(c: CallbackRecord): Promise<void>;
  /** Marks pending callbacks for this number as resolved because the caller rang back. */
  resolveCallbacks(callerNumber: string): Promise<number>;
  pendingCallbacks(): Promise<(CallbackRecord & { id: string | number })[]>;
  dashboardRows(sinceIso?: string): Promise<DashboardRow[]>;
  /** Voice: remember a call's caller number as soon as the provider reports the call. */
  noteCallStarted(callId: string, callerNumber: string | undefined, atIso: string): Promise<void>;
  callerNumberFor(callId: string): Promise<string | undefined>;
  /** True once an enquiry with this id has been finalised. */
  isCompleted(enquiryId: string): Promise<boolean>;
}

/** Accepts the project URL with or without a pasted "/rest/v1/" suffix. */
export function supabaseBaseUrl(raw: string): string {
  const u = new URL(raw.trim());
  return u.origin;
}

export async function getStore(): Promise<Store> {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const { SupabaseStore } = await import("./supabase");
    return new SupabaseStore(supabaseBaseUrl(process.env.SUPABASE_URL), process.env.SUPABASE_SERVICE_ROLE_KEY.trim());
  }
  const { memoryStore } = await import("./memory");
  return memoryStore();
}
