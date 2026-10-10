// Builds the note a designer receives. No pricing anywhere: every agent-authored
// field is scanned by the same guardrail rules before the note leaves the core.
import { STUDIO } from "./config";
import { findPricingViolations } from "./guardrail";
import { weeksBetween } from "./timeline";
import type { Enquiry, Facts, HandoffNote, Outcome, Qualification, Turn } from "./types";

export function formatIST(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: STUDIO.timezone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }) + " IST";
}

const day = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const PROJECT_LABEL = { full_home: "Full home", partial: "Partial home", single_room: "Single room", office: "Office" } as const;

export function transcriptText(turns: Turn[]): string {
  return turns.map((t) => `${t.speaker === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n");
}

export function buildHandoffNote(e: Enquiry, f: Facts, q: Qualification, o: Outcome, transcript: Turn[], bookingUrl?: string): HandoffNote {
  const now = new Date(e.receivedAt);
  const t = f.timeline;
  const c3 = q.criteria.find((c) => c.id === 3)!;
  const timelineParts = [
    t.deadline && `Deadline "${t.deadlineEvent ?? t.deadlineRaw ?? day(t.deadline)}" (~${Math.round(weeksBetween(now, new Date(t.deadline)))} weeks)`,
    t.startRaw && `Start: ${t.startRaw}`,
    t.siteAvailable && (t.siteAvailable <= e.receivedAt.slice(0, 10) ? "Site available now" : `Site available ~${day(t.siteAvailable)}`),
    t.noRush && "No rush",
  ].filter(Boolean);

  const property = [f.property, f.rented ? "rented (landlord OK, non-structural only)" : undefined].filter(Boolean).join(", ");
  const scope = [
    f.rooms.length ? f.rooms.join(", ") : undefined,
    property || undefined,
    f.siteVisitRequested ? "site visit requested" : undefined,
    f.referral ? `referral/source: ${f.referral}` : undefined,
  ].filter(Boolean).join("; ");

  const note: HandoffNote = {
    callerName: f.callerName ?? e.caller.name ?? "Not given",
    callerNumber: e.caller.number ?? "Not captured",
    channel: e.channel,
    timestamp: formatIST(e.receivedAt),
    projectType: f.projectType ? PROJECT_LABEL[f.projectType] : "Not yet clear",
    location: f.location ?? "Not given",
    inServiceArea: f.area === "listed" ? "Yes (listed area)" : f.area === "adjoining" ? "Yes (adjoining area — please confirm)" : "Not confirmed",
    approxSizeSqft: f.sqft ? `${f.sqft.toLocaleString("en-IN")} sq ft` : "Not given",
    scopeSummary: scope || "Not detailed on the call",
    timeline: timelineParts.join("; ") || "Not given",
    leadTimeCheck: `${c3.status}: ${c3.reason}`,
    decisionMaker: `${f.decisionMaker.status === "self" ? "Present" : f.decisionMaker.status === "represented" ? "Represented" : "Unclear"} — ${f.decisionMaker.note ?? "not discussed"}`,
    budgetNote: f.budget ? `Caller volunteered a budget (${q.criteria.find((c) => c.id === 4)!.reason})` : undefined,
    qualification: q.verdict === "QUALIFIED" ? "QUALIFIED" : "UNCERTAIN",
    uncertainCriteria: q.criteria.filter((c) => c.status === "UNCERTAIN").map((c) => `${c.id}. ${c.name} — ${c.reason}`),
    consultation: bookingUrl ? `Booking link sent to caller: ${bookingUrl} (slot to be picked by caller)` : "Booking link pending",
    priority: o.recovery ? "HANDLE WITH CARE — we missed this caller's earlier enquiry; they are frustrated. Same-day outreach." : undefined,
    transcript: transcriptText(transcript),
  };
  assertNoPricing(note);
  return note;
}

/** Throws if any field of the note carries pricing. Caller lines in the transcript are exempt. */
export function assertNoPricing(note: HandoffNote): void {
  const agentTranscript = note.transcript.split("\n").filter((l) => l.startsWith("Agent:")).join("\n");
  const { transcript: _t, ...fields } = note;
  const problems = findPricingViolations(JSON.stringify(fields).replace(/\d[\d,]* sq ft/g, "")).concat(findPricingViolations(agentTranscript));
  if (problems.length) throw new Error(`Handoff note contains pricing: ${problems.join(", ")}`);
}

export function renderHandoffText(n: HandoffNote): string {
  const lines = [
    `🏠 NEW ${n.qualification} LEAD — Aangan Studio`,
    n.priority ? `⚠️ ${n.priority}` : undefined,
    ``,
    `Caller: ${n.callerName} · ${n.callerNumber}`,
    `Channel: ${n.channel} · ${n.timestamp}`,
    `Project: ${n.projectType}`,
    `Location: ${n.location} — in service area: ${n.inServiceArea}`,
    `Size: ${n.approxSizeSqft}`,
    `Scope: ${n.scopeSummary}`,
    `Timeline: ${n.timeline}`,
    `Lead-time check: ${n.leadTimeCheck}`,
    `Decision-maker: ${n.decisionMaker}`,
    n.budgetNote ? `Budget: ${n.budgetNote}` : undefined,
    `Qualification: ${n.qualification}${n.uncertainCriteria.length ? `\nUncertain:\n- ${n.uncertainCriteria.join("\n- ")}` : ""}`,
    `Consultation: ${n.consultation}`,
    ``,
    `— Transcript —`,
    n.transcript,
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}
