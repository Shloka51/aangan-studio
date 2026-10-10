// T01–T20 from Aangan_Sep_2026_Enquiries.pdf, replayed through the core with zero network.
import { describe, expect, it } from "vitest";
import { PRICING_DEFLECTION } from "@/core/knowledge";
import { findPricingViolations, isPricingQuestion } from "@/core/guardrail";
import { processEnquiry } from "@/core/session";
import { deps } from "./support/deps";
import { loadFixtures, toEnquiry } from "./support/fixtures";

const fixtures = loadFixtures();

describe("labelled phone transcripts", () => {
  it("covers all 20 calls (T17 as two calls)", () => {
    expect(fixtures.map((f) => f.id)).toEqual(["T01", "T02", "T03", "T04", "T05", "T06", "T07", "T08", "T09", "T10", "T11", "T12", "T13", "T14", "T15", "T16", "T17a", "T17b", "T18", "T19", "T20"]);
  });

  for (const f of fixtures) {
    it(`${f.id} → ${f.expected.outcome}${f.expected.declineReason ? ` (${f.expected.declineReason})` : ""}`, async () => {
      const e = toEnquiry(f);
      const r = await processEnquiry(e, deps(e));
      expect(r.outcome.kind).toBe(f.expected.outcome);
      if (f.expected.declineReason) expect(r.outcome.declineReason).toBe(f.expected.declineReason);
      if (f.expected.recovery) expect(r.outcome.recovery).toBe(true);

      // Never a dead end: a next step and at least one action, always.
      expect(r.outcome.nextStep.length).toBeGreaterThan(10);
      expect(r.actions.length).toBeGreaterThan(0);

      // No agent turn ever carries pricing.
      for (const t of r.transcript.filter((t) => t.speaker === "agent")) expect(findPricingViolations(t.text)).toEqual([]);

      // Outcome-specific actions.
      const types = r.actions.map((a) => a.type);
      if (r.outcome.kind === "QUALIFIED") {
        expect(types).toContain("book_consultation");
        expect(types).toContain("send_handoff");
        expect(r.handoffNote).toBeDefined();
      } else expect(r.handoffNote).toBeUndefined();
      if (r.outcome.kind === "ESCALATED") expect(types).toContain("escalate");
      if (r.outcome.kind === "CALLBACK") expect(r.actions.find((a) => a.type === "queue_callback")).toMatchObject({ callerNumber: f.caller.number });
      if (r.outcome.kind === "DECLINED") expect(types).toContain("log_decline");
    });
  }
});

describe("pricing questions (T02, T13) pass while refusing a price", () => {
  for (const id of ["T02", "T13"]) {
    it(`${id}: every pricing question gets exactly the scripted deflection, and the lead is booked`, async () => {
      const f = fixtures.find((x) => x.id === id)!;
      const e = toEnquiry(f);
      const r = await processEnquiry(e, deps(e));
      let pricingTurns = 0;
      r.transcript.forEach((t, i) => {
        if (t.speaker === "caller" && isPricingQuestion(t.text)) {
          pricingTurns++;
          expect(r.transcript[i + 1].text).toBe(PRICING_DEFLECTION);
        }
      });
      expect(pricingTurns).toBe(2);
      expect(r.outcome.kind).toBe("QUALIFIED");
      expect(r.actions.map((a) => a.type)).toContain("book_consultation");
    });
  }
});

describe("specific behaviours from the transcripts", () => {
  const run = async (id: string) => {
    const e = toEnquiry(fixtures.find((x) => x.id === id)!);
    return processEnquiry(e, deps(e));
  };

  it("T01 picks the caller's site (Kothrud), not the friend's (Aundh)", async () => {
    const r = await run("T01");
    expect(r.facts.location).toBe("Kothrud");
    expect(r.facts.callerName).toBe("Priya");
    expect(r.handoffNote!.qualification).toBe("QUALIFIED");
  });

  it("T07 offers a start after Diwali and schedules the follow-up", async () => {
    const r = await run("T07");
    expect(r.transcript.some((t) => t.action === "offer_deferred_start" && /November/.test(t.text))).toBe(true);
    expect(r.actions.find((a) => a.type === "schedule_followup")).toMatchObject({ date: "2026-11-09" });
  });

  it("T09 escalates to the studio head with a 15-minute callback", async () => {
    const r = await run("T09");
    expect(r.actions.find((a) => a.type === "escalate")).toMatchObject({ to: "studio_head", callbackWithinMinutes: 15 });
    expect(r.facts.callerName).toBe("Sheetal Deshpande");
  });

  it("T10 declines on budget without repeating the caller's figure", async () => {
    const r = await run("T10");
    const decline = r.transcript.find((t) => t.action === "decline")!;
    expect(decline.text).not.toMatch(/\d|lakh/i);
    expect(decline.text).toMatch(/budget you mentioned/);
  });

  it("T14 is qualified with the decision-maker noted as uncertain (parents decide)", async () => {
    const r = await run("T14");
    expect(r.qualification.uncertain).toContain(5);
    expect(r.handoffNote!.qualification).toBe("UNCERTAIN");
    expect(r.handoffNote!.decisionMaker).toMatch(/Represented/);
  });

  it("T15: possession in six weeks is enough lead time", async () => {
    const r = await run("T15");
    expect(r.qualification.criteria[2].status).toBe("PASS");
  });

  it("T16 books directly with a handle-with-care flag", async () => {
    const r = await run("T16");
    expect(r.handoffNote!.priority).toMatch(/HANDLE WITH CARE/);
    expect(r.transcript.filter((t) => t.action?.startsWith("ask_"))).toHaveLength(0);
  });

  it("T17b resolves the pending callback from the dropped first call", async () => {
    const r = await run("T17b");
    expect(r.actions[0]).toEqual({ type: "resolve_callback", callerNumber: fixtures.find((x) => x.id === "T17b")!.caller.number });
  });

  it("T08 (missed at 10:47pm) is after hours and queued for the next business morning", async () => {
    const r = await run("T08");
    expect(r.afterHours).toBe(true);
    const cb = r.actions.find((a) => a.type === "queue_callback")!;
    expect(cb.type === "queue_callback" && new Date(cb.dueBy).toISOString()).toBe("2026-09-10T04:45:00.000Z"); // 10:15 IST
  });

  it("asks at most one question per unclear criterion", async () => {
    for (const f of fixtures) {
      const e = toEnquiry(f);
      const r = await processEnquiry(e, deps(e));
      const asks = r.transcript.filter((t) => t.action?.startsWith("ask_")).map((t) => t.action);
      expect(new Set(asks).size).toBe(asks.length);
    }
  });
});
