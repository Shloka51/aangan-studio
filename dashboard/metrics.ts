// Dashboard metrics, computed from store rows. Pure, so it is unit-tested.
import type { DashboardRow } from "@/store";

export interface Metrics {
  received: number;
  answeredUnder5MinPct: number; // of all enquiries
  medianResponseSec?: number; // over enquiries that got a response
  unanswered: number;
  qualificationRatePct: number; // QUALIFIED / new-project enquiries (excl. escalations & callbacks)
  qualified: number;
  newProjectEnquiries: number;
  booked: number;
  outcomes: { kind: string; count: number }[];
  declineReasons: { reason: string; count: number }[];
  costInr: number;
  costPerEnquiryInr: number;
  costPerBookingInr?: number;
  tokens: number;
  afterHours: { inHours: SplitStats; afterHours: SplitStats };
}

export interface SplitStats {
  received: number;
  qualified: number;
  booked: number;
}

const OUTCOME_ORDER = ["QUALIFIED", "DECLINED", "ESCALATED", "CALLBACK"];

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeMetrics(rows: DashboardRow[]): Metrics {
  const responseSecs = rows
    .filter((r) => r.firstResponseAt)
    .map((r) => Math.max(0, (new Date(r.firstResponseAt!).getTime() - new Date(r.receivedAt).getTime()) / 1000));
  const under5 = responseSecs.filter((s) => s <= 300).length;
  const newProject = rows.filter((r) => r.outcome === "QUALIFIED" || r.outcome === "DECLINED");
  const qualified = rows.filter((r) => r.outcome === "QUALIFIED").length;
  const booked = rows.filter((r) => r.booked).length;
  const costInr = rows.reduce((s, r) => s + r.costInr, 0);
  const split = (xs: DashboardRow[]): SplitStats => ({ received: xs.length, qualified: xs.filter((r) => r.outcome === "QUALIFIED").length, booked: xs.filter((r) => r.booked).length });
  const declines = new Map<string, number>();
  for (const r of rows) if (r.outcome === "DECLINED" && r.declineReason) declines.set(r.declineReason, (declines.get(r.declineReason) ?? 0) + 1);

  return {
    received: rows.length,
    answeredUnder5MinPct: rows.length ? (under5 / rows.length) * 100 : 0,
    medianResponseSec: median(responseSecs),
    unanswered: rows.length - responseSecs.length,
    qualificationRatePct: newProject.length ? (qualified / newProject.length) * 100 : 0,
    qualified,
    newProjectEnquiries: newProject.length,
    booked,
    outcomes: OUTCOME_ORDER.map((kind) => ({ kind, count: rows.filter((r) => r.outcome === kind).length })),
    declineReasons: [...declines].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    costInr,
    costPerEnquiryInr: rows.length ? costInr / rows.length : 0,
    costPerBookingInr: booked ? costInr / booked : undefined,
    tokens: rows.reduce((s, r) => s + r.tokens, 0),
    afterHours: { inHours: split(rows.filter((r) => !r.afterHours)), afterHours: split(rows.filter((r) => r.afterHours)) },
  };
}
