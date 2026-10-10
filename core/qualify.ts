// The five criteria from qualified.md, applied deterministically to extracted facts.
import { CRITERIA_NAMES, STUDIO } from "./config";
import { COM_MIN_RATE, RES_MIN_RATE, SINGLE_ROOM_MIN } from "./knowledge";
import { weeksBetween } from "./timeline";
import type { CriterionId, CriterionResult, CriterionStatus, DeclineReason, Facts, Qualification } from "./types";

const BHK_SQFT: Record<string, number> = { "1BHK": 550, "2BHK": 850, "3BHK": 1100, "4BHK": 1800, "5BHK": 2400 };

/**
 * Internal lowest plausible cost for the described scope, from pricing.md. Used only
 * to decide whether a volunteered budget is clearly too low. Never surfaced anywhere.
 */
export function internalScopeFloor(f: Facts): number | undefined {
  if (f.segment === "commercial") return f.sqft ? f.sqft * COM_MIN_RATE : undefined;
  const rooms = f.rooms.filter((r) => !["flooring", "wardrobes"].includes(r)).length;
  if (f.projectType === "single_room") return SINGLE_ROOM_MIN;
  if (f.projectType === "partial") return Math.max(2, rooms) * SINGLE_ROOM_MIN;
  if (f.projectType === "full_home") {
    const sqft = f.sqft ?? (f.property ? BHK_SQFT[f.property] : undefined);
    return sqft ? sqft * RES_MIN_RATE : 2 * SINGLE_ROOM_MIN;
  }
  return undefined;
}

export interface QualifyContext {
  now: Date;
}

function result(id: CriterionId, status: CriterionStatus, reason: string): CriterionResult {
  return { id, name: CRITERIA_NAMES[id], status, reason };
}

export function criterion1(f: Facts): CriterionResult & { decline?: DeclineReason } {
  if (f.outOfScope) {
    const what = { restaurant: "Restaurant / hospitality", hotel: "Hotel / hospitality", retail: "Retail", gym: "Gym / fitness", architecture: "Structural / architecture work", vastu_only: "Standalone Vastu advice", furniture_only: "Standalone furniture sourcing" }[f.outOfScope];
    return { ...result(1, "FAIL", `${what} is outside the studio's scope.`), decline: "out_of_scope_type" };
  }
  if (f.segment === "commercial" && f.sqft !== undefined && f.sqft < STUDIO.commercialMinSqft)
    return { ...result(1, "FAIL", `Commercial space of ~${f.sqft} sq ft is below the studio's minimum commercial scope.`), decline: "below_min_commercial" };
  if (f.segment === "commercial" && f.sqft !== undefined && f.sqft > STUDIO.commercialMaxSqft * 1.2)
    return { ...result(1, "FAIL", `Commercial space of ~${f.sqft} sq ft is above the studio's commercial range.`), decline: "above_max_commercial" };
  if (f.adviceOnly) return { ...result(1, "FAIL", "Caller wants ideas/advice only, not design with execution."), decline: "advice_only" };
  if (f.wantsExecution) return result(1, "PASS", "Wants design with execution.");
  return result(1, "UNCERTAIN", "Not yet clear whether this is design + execution or advice.");
}

export function criterion2(f: Facts): CriterionResult & { decline?: DeclineReason } {
  if (f.area === "listed") return result(2, "PASS", `${f.location} is in the service area (services.md).`);
  if (f.area === "adjoining") return result(2, "PASS", `${f.location} treated as an adjoining Pune/PCMC area — confirm.`);
  if (f.area === "out") return { ...result(2, "FAIL", `${f.location} is outside Pune / PCMC.`), decline: "out_of_area" };
  return result(2, "UNCERTAIN", "Site location not given.");
}

export function criterion3(f: Facts, { now }: QualifyContext): CriterionResult & { decline?: DeclineReason } {
  const t = f.timeline;
  if (t.deadline) {
    const weeks = weeksBetween(now, new Date(t.deadline));
    const label = t.deadlineEvent ?? t.deadlineRaw ?? new Date(t.deadline).toDateString();
    if (weeks < STUDIO.minLeadWeeks)
      return { ...result(3, "FAIL", `Deadline "${label}" (~${Math.max(0, Math.round(weeks))} weeks) — under the ${STUDIO.minLeadWeeks}-week minimum lead time.`), decline: "impossible_timeline" };
    if (weeks < STUDIO.minCompletionWeeks)
      return { ...result(3, "FAIL", `Deadline "${label}" (~${Math.round(weeks)} weeks) — design plus execution needs at least ${STUDIO.minCompletionWeeks}.`), decline: "impossible_timeline" };
  }
  if (t.siteAvailable && weeksBetween(now, new Date(t.siteAvailable)) > STUDIO.maxSiteWaitWeeks)
    return result(3, "UNCERTAIN", `Site not available until ${new Date(t.siteAvailable).toDateString()}, beyond the ${STUDIO.maxSiteWaitWeeks}-week window.`);
  if (t.urgent && !t.deadline) return result(3, "UNCERTAIN", "Caller sounds urgent but gave no completion date.");
  if (t.deadline) return result(3, "PASS", `Deadline "${t.deadlineEvent ?? t.deadlineRaw ?? new Date(t.deadline).toDateString()}": ~${Math.round(weeksBetween(now, new Date(t.deadline)))} weeks away.`);
  if (t.start || t.siteAvailable || t.noRush) return result(3, "PASS", `${t.startRaw ? `Start: ${t.startRaw}. ` : ""}${t.siteAvailable ? "Site available. " : ""}${t.noRush ? "No rush." : ""}`.trim());
  return result(3, "UNCERTAIN", "No completion date given.");
}

export function criterion4(f: Facts): CriterionResult & { decline?: DeclineReason } {
  if (!f.budget?.maxInr) return result(4, "PASS", "Budget not mentioned — not probed (as per rubric).");
  const floor = internalScopeFloor(f);
  if (!floor) return result(4, "UNCERTAIN", "Budget volunteered; scope too vague to sanity-check.");
  const ratio = f.budget.maxInr / floor;
  if (ratio < STUDIO.budgetClearlyLowFraction) return { ...result(4, "FAIL", "Volunteered budget is clearly below what this scope costs with us."), decline: "budget_mismatch" };
  if (ratio < STUDIO.budgetTightFraction) return result(4, "UNCERTAIN", "Volunteered budget may be tight for this scope — designer to discuss.");
  return result(4, "PASS", "Volunteered budget looks consistent with the scope.");
}

export function criterion5(f: Facts): CriterionResult {
  // qualified.md boundary rule: unclear on 5 is treated as qualified with a note.
  if (f.decisionMaker.status === "self") return result(5, "PASS", f.decisionMaker.note ?? "Caller is the decision-maker.");
  return result(5, "UNCERTAIN", f.decisionMaker.note ?? "Decision-maker not confirmed.");
}

export function qualify(f: Facts, ctx: QualifyContext): Qualification {
  const rs: (CriterionResult & { decline?: DeclineReason })[] = [criterion1(f), criterion2(f), criterion3(f, ctx), criterion4(f), criterion5(f)];
  const failed = rs.filter((r) => r.status === "FAIL");
  const uncertain = rs.filter((r) => r.status === "UNCERTAIN").map((r) => r.id);
  const declineReason: DeclineReason | undefined = failed.length >= 2 ? "multiple" : failed[0]?.decline;
  return {
    criteria: rs.map(({ id, name, status, reason }) => ({ id, name, status, reason })),
    failed: failed.map((r) => r.id),
    uncertain,
    verdict: failed.length ? "NOT_QUALIFIED" : uncertain.length ? "UNCERTAIN" : "QUALIFIED",
    declineReason,
  };
}
