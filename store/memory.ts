// In-memory store for the harness and tests. Same behaviour as the Supabase store.
import type { SessionState } from "@/core/session";
import type { EnquiryResult } from "@/core/types";
import type { CallbackRecord, DashboardRow, HandoffRecord, Store } from "./index";

export class MemoryStore implements Store {
  sessions = new Map<string, SessionState>();
  results = new Map<string, EnquiryResult>();
  handoffs: HandoffRecord[] = [];
  bookings: { enquiryId: string; url: string }[] = [];
  callbacks: (CallbackRecord & { id: number; status: "pending" | "done" | "resolved_by_caller" })[] = [];
  calls = new Map<string, { callerNumber?: string; startedAt: string }>();

  async noteCallStarted(callId: string, callerNumber: string | undefined, atIso: string) {
    const prev = this.calls.get(callId);
    this.calls.set(callId, { callerNumber: callerNumber ?? prev?.callerNumber, startedAt: prev?.startedAt ?? atIso });
  }
  async callerNumberFor(callId: string) {
    return this.calls.get(callId)?.callerNumber ?? this.sessions.get(callId)?.enquiry.caller.number;
  }
  async isCompleted(enquiryId: string) {
    return this.results.has(enquiryId);
  }

  async saveSession(s: SessionState) {
    this.sessions.set(s.enquiry.id, structuredClone(s));
  }
  async loadSessionByExternalId(externalId: string) {
    for (const s of this.sessions.values()) if (s.enquiry.externalId === externalId) return structuredClone(s);
    return null;
  }
  async saveResult(r: EnquiryResult) {
    this.results.set(r.enquiry.id, r);
  }
  async recordHandoff(h: HandoffRecord) {
    this.handoffs.push(h);
  }
  async recordBooking(enquiryId: string, url: string) {
    this.bookings.push({ enquiryId, url });
  }
  async queueCallback(c: CallbackRecord) {
    this.callbacks.push({ ...c, id: this.callbacks.length + 1, status: "pending" });
  }
  async resolveCallbacks(callerNumber: string) {
    let n = 0;
    for (const c of this.callbacks)
      if (c.callerNumber === callerNumber && c.kind === "callback" && c.status === "pending") {
        c.status = "resolved_by_caller";
        n++;
      }
    return n;
  }
  async pendingCallbacks() {
    return this.callbacks.filter((c) => c.status === "pending");
  }
  async dashboardRows(sinceIso?: string): Promise<DashboardRow[]> {
    return [...this.results.values()]
      .filter((r) => !sinceIso || r.enquiry.receivedAt >= sinceIso)
      .map((r) => ({
        id: r.enquiry.id,
        channel: r.enquiry.channel,
        callerName: r.facts.callerName,
        callerNumber: r.enquiry.caller.number,
        receivedAt: r.enquiry.receivedAt,
        firstResponseAt: r.firstResponseAt,
        outcome: r.outcome.kind,
        declineReason: r.outcome.declineReason,
        recovery: !!r.outcome.recovery,
        afterHours: r.afterHours,
        qualification: r.qualification.verdict,
        booked: this.bookings.some((b) => b.enquiryId === r.enquiry.id),
        costInr: r.usage.reduce((s, u) => s + u.costInr, 0),
        tokens: r.usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0),
      }));
  }
}

let singleton: MemoryStore | undefined;
export function memoryStore(): MemoryStore {
  return (singleton ??= new MemoryStore());
}
