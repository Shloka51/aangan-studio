// Supabase (Postgres) store. Schema: supabase/migrations/0001_init.sql.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SessionState } from "@/core/session";
import type { EnquiryResult } from "@/core/types";
import type { CallbackRecord, DashboardRow, HandoffRecord, Store } from "./index";

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`supabase ${what}: ${res.error.message}`);
  return res.data;
}

export class SupabaseStore implements Store {
  private db: SupabaseClient;
  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, { auth: { persistSession: false } });
  }

  async saveSession(s: SessionState) {
    const e = s.enquiry;
    check(
      await this.db.from("enquiries").upsert({
        id: e.id,
        external_id: e.externalId ?? null,
        channel: e.channel,
        caller_name: s.facts.callerName ?? e.caller.name ?? null,
        caller_number: e.caller.number ?? null,
        received_at: e.receivedAt,
        first_response_at: s.firstResponseAt ?? null,
        contact_status: e.status,
        language: s.facts.language,
        facts: s.facts,
        session: s,
      }),
      "save session",
    );
  }

  async loadSessionByExternalId(externalId: string) {
    const data = check(await this.db.from("enquiries").select("session").eq("external_id", externalId).maybeSingle(), "load session");
    return (data?.session as SessionState | undefined) ?? null;
  }

  async saveResult(r: EnquiryResult) {
    const e = r.enquiry;
    check(
      await this.db.from("enquiries").upsert({
        id: e.id,
        external_id: e.externalId ?? null,
        channel: e.channel,
        caller_name: r.facts.callerName ?? e.caller.name ?? null,
        caller_number: e.caller.number ?? null,
        received_at: e.receivedAt,
        first_response_at: r.firstResponseAt ?? null,
        ended_at: new Date().toISOString(),
        contact_status: e.status,
        state: "completed",
        outcome: r.outcome.kind,
        decline_reason: r.outcome.declineReason ?? null,
        recovery: !!r.outcome.recovery,
        after_hours: r.afterHours,
        language: r.facts.language,
        facts: r.facts,
      }),
      "save enquiry",
    );
    check(await this.db.from("turns").delete().eq("enquiry_id", e.id), "clear turns");
    if (r.transcript.length)
      check(
        await this.db.from("turns").insert(
          r.transcript.map((t, idx) => ({ enquiry_id: e.id, idx, speaker: t.speaker, text: t.text, action: t.action ?? null, guardrail_triggered: !!t.guardrail, at: t.at ?? null })),
        ),
        "insert turns",
      );
    check(
      await this.db.from("qualifications").upsert({
        enquiry_id: e.id,
        verdict: r.qualification.verdict,
        criteria: r.qualification.criteria,
        failed: r.qualification.failed,
        uncertain: r.qualification.uncertain,
      }),
      "save qualification",
    );
    if (r.usage.length)
      check(
        await this.db.from("cost").insert(
          r.usage.map((u) => ({ enquiry_id: e.id, provider: u.provider, model: u.model, purpose: u.purpose, input_tokens: u.inputTokens, output_tokens: u.outputTokens, cost_inr: u.costInr })),
        ),
        "insert cost",
      );
  }

  async recordHandoff(h: HandoffRecord) {
    check(await this.db.from("handoffs").insert({ enquiry_id: h.enquiryId, kind: h.kind, channel: h.channel, status: h.status, note: h.note ?? null, body: h.body, error: h.error ?? null }), "record handoff");
  }

  async recordBooking(enquiryId: string, url: string) {
    check(await this.db.from("bookings").insert({ enquiry_id: enquiryId, url }), "record booking");
  }

  async queueCallback(c: CallbackRecord) {
    check(await this.db.from("callbacks").insert({ enquiry_id: c.enquiryId ?? null, caller_number: c.callerNumber ?? null, kind: c.kind, reason: c.reason, due_by: c.dueBy }), "queue callback");
  }

  async resolveCallbacks(callerNumber: string) {
    const data = check(
      await this.db.from("callbacks").update({ status: "resolved_by_caller", resolved_at: new Date().toISOString() }).eq("caller_number", callerNumber).eq("kind", "callback").eq("status", "pending").select("id"),
      "resolve callbacks",
    );
    return data?.length ?? 0;
  }

  async pendingCallbacks() {
    const data = check(await this.db.from("callbacks").select("*").eq("status", "pending").order("due_by"), "pending callbacks");
    return (data ?? []).map((c) => ({ id: c.id, enquiryId: c.enquiry_id, callerNumber: c.caller_number, kind: c.kind, reason: c.reason, dueBy: c.due_by }));
  }

  async dashboardRows(sinceIso?: string): Promise<DashboardRow[]> {
    let q = this.db
      .from("enquiries")
      .select("id, channel, caller_name, caller_number, received_at, first_response_at, outcome, decline_reason, recovery, after_hours, qualifications(verdict), bookings(id), cost(cost_inr, input_tokens, output_tokens)")
      .eq("state", "completed")
      .order("received_at", { ascending: false })
      .limit(5000);
    if (sinceIso) q = q.gte("received_at", sinceIso);
    const data = check(await q, "dashboard rows") as unknown as Record<string, any>[];
    return data.map((r) => {
      const qual = Array.isArray(r.qualifications) ? r.qualifications[0] : r.qualifications;
      const cost = (r.cost ?? []) as { cost_inr: number; input_tokens: number; output_tokens: number }[];
      return {
        id: r.id,
        channel: r.channel,
        callerName: r.caller_name ?? undefined,
        callerNumber: r.caller_number ?? undefined,
        receivedAt: r.received_at,
        firstResponseAt: r.first_response_at ?? undefined,
        outcome: r.outcome ?? undefined,
        declineReason: r.decline_reason ?? undefined,
        recovery: r.recovery,
        afterHours: r.after_hours,
        qualification: qual?.verdict,
        booked: (r.bookings ?? []).length > 0,
        costInr: cost.reduce((s, c) => s + Number(c.cost_inr), 0),
        tokens: cost.reduce((s, c) => s + c.input_tokens + c.output_tokens, 0),
      };
    });
  }
}
