import { describe, expect, it } from "vitest";
import { rulesBrain } from "@/adapters/brain";
import { enforcePricingGuardrail, findPricingViolations, isPricingQuestion } from "@/core/guardrail";
import { assertNoPricing, buildHandoffNote } from "@/core/handoff";
import { PRICING_DEFLECTION, PRICING_DEFLECTION_HINGLISH, PRICING_FIGURES } from "@/core/knowledge";
import { buildSystemPrompt } from "@/core/prompt";
import { processEnquiry } from "@/core/session";
import { deps, LeakyNLG } from "./support/deps";
import { loadFixtures, toEnquiry } from "./support/fixtures";

describe("pricing guardrail (hard check over model output)", () => {
  const leaks = [
    "For a 2BHK it's typically ₹18–22 lakh.",
    "Our rates start at 1,800 per sq ft.",
    "Standard spec is 1800/sqft and premium 2400.",
    "It'll cost around 15 lakhs.",
    "Rs 3,50,000 for a bedroom.",
    "A single room is 3.5 to 8 lakh all-in.",
    "Roughly two thousand per square foot.",
    "Offices start at 1200 psf.",
    "Somewhere between ten and fifteen lakh.",
    "INR 20L should cover it.",
    "Aapka kharcha lagbhag 20 lakh aayega.",
    "Expect about 25k per room.",
    "The ballpark is 12 lakh.",
    "Fees are 10% of the project.",
    "It would be 1.5 crore for the villa.",
    "We charge 2,800 for premium offices.",
  ];
  for (const leak of leaks) {
    it(`blocks: ${leak}`, () => {
      expect(findPricingViolations(leak).length).toBeGreaterThan(0);
      const r = enforcePricingGuardrail(leak, { callerAskedPricing: false, language: "en" });
      expect(r.rewritten).toBe(true);
      expect(r.text).toBe(PRICING_DEFLECTION);
    });
  }

  const clean = [
    "When would you need the project complete?",
    "Our design phase alone takes 3–4 weeks, and execution follows.",
    "A room redesign with execution takes at least 8–10 weeks from start to finish.",
    "Nikhil or a senior person will call you back within 15 minutes.",
    "About 1,400 sq ft — that's a lovely size for a 3BHK.",
    "The budget you mentioned would be significantly below what a project of that scope would cost with us.",
    PRICING_DEFLECTION,
    PRICING_DEFLECTION_HINGLISH,
  ];
  for (const ok of clean) {
    it(`allows: ${ok.slice(0, 60)}`, () => {
      expect(findPricingViolations(ok)).toEqual([]);
    });
  }

  it("replaces ANY reply to a pricing question with the exact deflection, even a number-free one", () => {
    const r = enforcePricingGuardrail("It really varies, let's chat at the consultation!", { callerAskedPricing: true, language: "en" });
    expect(r.text).toBe(PRICING_DEFLECTION);
    expect(r.rewritten).toBe(true);
    expect(enforcePricingGuardrail("anything", { callerAskedPricing: true, language: "hinglish" }).text).toBe(PRICING_DEFLECTION_HINGLISH);
  });

  it("detects pricing questions in English and Hinglish, not false friends", () => {
    for (const q of ["how much would it cost?", "Even a range?", "what's your per sq ft rate", "can you give me a rough ballpark", "kitna kharcha aayega?", "range bata do", "What might it cost?", "What are your fees?", "Is it expensive?"])
      expect(isPricingQuestion(q), q).toBe(true);
    for (const q of ["How much time does design take?", "Not even for a smaller fee?", "My budget is 1 to 1.5 lakh maximum. Is that possible with you?", "We move in November"])
      expect(isPricingQuestion(q), q).toBe(false);
  });

  it("a hostile model that leaks a price in every reply never reaches a caller (all transcripts)", async () => {
    for (const f of loadFixtures()) {
      const e = toEnquiry(f);
      const r = await processEnquiry(e, deps(e, { nlu: rulesBrain().nlu, nlg: new LeakyNLG() }));
      for (const t of r.transcript.filter((t) => t.speaker === "agent")) {
        expect(findPricingViolations(t.text), `${f.id}: ${t.text}`).toEqual([]);
      }
      if (r.transcript.some((t) => t.speaker === "agent")) expect(r.guardrailEvents.length).toBeGreaterThan(0);
      if (r.handoffNote) assertNoPricing(r.handoffNote);
    }
  });

  it("the model prompt never contains a pricing.md figure", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(PRICING_DEFLECTION);
    expect(prompt).not.toMatch(/₹|per sq ft \|/);
    for (const fig of PRICING_FIGURES.filter((x) => x.length >= 4)) expect(prompt).not.toContain(Number(fig).toLocaleString("en-IN"));
  });

  it("handoff notes refuse to carry agent-authored pricing", async () => {
    const f = loadFixtures().find((x) => x.id === "T01")!;
    const e = toEnquiry(f);
    const r = await processEnquiry(e, deps(e));
    expect(() => assertNoPricing({ ...r.handoffNote!, scopeSummary: "Standard spec ~₹1,800 per sq ft" })).toThrow(/pricing/);
    expect(() => buildHandoffNote(e, r.facts, r.qualification, r.outcome, [...r.transcript, { speaker: "agent", text: "That'll be about 20 lakh." }])).toThrow(/pricing/);
  });
});
