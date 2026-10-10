// Hard pricing guardrail. Runs over EVERY agent reply after the model (or template)
// produces it, and over every handoff note. It does not trust the prompt.
//
// Rules (pricing.md "What the agent must never say"):
//  - If the caller's turn is a pricing question, the reply is replaced with the
//    approved deflection, whatever the model wrote.
//  - Any reply that contains a money amount, a rate, a pricing.md figure or a
//    "cost around / rates start at / typically" phrase is replaced with the deflection.
import { APPROVED_DEFLECTIONS, PRICING_DEFLECTION, PRICING_DEFLECTION_HINGLISH, PRICING_FIGURES } from "./knowledge";
import type { Language } from "./types";

const NUM = String.raw`\d[\d,]*(?:\.\d+)?`;
const NUMBER_WORD = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|fifty|hundred|ek|do|teen|char|paanch|das|bees|pachaas|sau|dedh|dhai|half)`;

const RULES: { name: string; re: RegExp }[] = [
  { name: "currency symbol", re: /₹|\bINR\b|\bRs\.?\s*\d|\brupees?\b|\brupaye?\b|\brs\b/i },
  { name: "lakh/crore", re: /\b(lakhs?|lacs?|lakh?s?|crores?|cr)\b/i },
  { name: "thousand money word", re: new RegExp(String.raw`\b(${NUM}|${NUMBER_WORD})\s*(k|thousand|hazaar|hazar)\b`, "i") },
  { name: "per-sq-ft rate", re: /\b(per|\/|a|an)\s*(sq\.?\s*ft|sqft|square\s*(foot|feet)|sft|psf)\b|\bpsf\b|\bper\s+sq/i },
  { name: "rate wording", re: /\b(rates?|charges?|fees?|costs?|pricing|prices?|budget|kharcha|kharch|daam)\b[^.?!]{0,40}\b(\d|one|two|three|four|five|ten|twenty|fifty|hundred|thousand)/i },
  { name: "number before cost wording", re: new RegExp(String.raw`(${NUM})[^.?!]{0,25}\b(rates?|costs?|price|fees?|charges?|budget|kharcha)\b`, "i") },
  { name: "estimate phrasing", re: /\b(it('|’)?ll cost|will cost|would cost around|costs? (around|about|roughly|approximately)|rates? start|starting (at|from) ₹?\d|typically (costs?|runs?|comes to)|ballpark (is|would be|of)|in the range of|somewhere between|range (is|would be))\b/i },
  { name: "range of numbers", re: new RegExp(String.raw`\b${NUM}\s*(?:-|–|—|to)\s*${NUM}\b(?!\s*(weeks?|months?|days?|years?|hafte|mahine|din|bhk|sq|square|am|pm|people|rooms?|minutes?))`, "i") },
];

function figureRules(): { name: string; re: RegExp }[] {
  // pricing.md figures with 3+ digits (e.g. 1800 / 1,800) anywhere, unless the text
  // is clearly an area ("1,800 sq ft" echoed back is an area, not a rate).
  return PRICING_FIGURES.filter((f) => f.replace(".", "").length >= 3).map((f) => {
    const withComma = f.length === 4 ? `${f[0]},?${f.slice(1)}` : f;
    return { name: `pricing.md figure ${f}`, re: new RegExp(String.raw`(?<![\d,])${withComma}(?![\d,])(?!\s*(sq|square))`, "i") };
  });
}
const ALL_RULES = [...RULES, ...figureRules()];

/** Returns the names of every pricing rule the text breaks (empty = clean). */
export function findPricingViolations(text: string): string[] {
  if (APPROVED_DEFLECTIONS.includes(text.trim())) return [];
  return ALL_RULES.filter((r) => r.re.test(text)).map((r) => r.name);
}

const PRICING_QUESTION = [
  /\b(how much|kitna|kitne|kitni)\b(?!\s+(time|longer|weeks?|months?|days?|space|area|sq))/i,
  /\b(cost|costs|costing|price|prices|pricing|priced|rate|rates|quote|quotation|estimate|ballpark|budget range|kharcha|kharch|daam|paisa|paise|expensive)\b/i,
  /\b(what('s| is| are) (your|the) (fees?|charges?)|(do|would|will) you charge)\b/i,
  /\b(per\s*sq\.?\s*ft|per square|psf|price list|rate card)\b/i,
  /\b(even a|rough|roughly a|give me a) range\b/i,
  /\brange (bata|batao|bataiye|do)\b/i,
];

/** True when the caller's turn asks about money in any form. */
export function isPricingQuestion(callerText: string): boolean {
  return PRICING_QUESTION.some((re) => re.test(callerText));
}

export function deflection(language: Language): string {
  return language === "hinglish" ? PRICING_DEFLECTION_HINGLISH : PRICING_DEFLECTION;
}

export interface GuardrailResult {
  text: string;
  rewritten: boolean;
  reasons: string[];
}

/**
 * The guardrail. `candidate` is whatever the brain produced; the return value is
 * what the caller hears.
 */
export function enforcePricingGuardrail(
  candidate: string,
  ctx: { callerAskedPricing: boolean; language: Language },
): GuardrailResult {
  const safe = deflection(ctx.language);
  if (ctx.callerAskedPricing) {
    const rewritten = candidate.trim() !== safe;
    const reasons = rewritten ? ["caller asked about pricing: only the scripted deflection is allowed", ...findPricingViolations(candidate)] : [];
    return { text: safe, rewritten, reasons };
  }
  const reasons = findPricingViolations(candidate);
  if (reasons.length) return { text: safe, rewritten: true, reasons };
  return { text: candidate, rewritten: false, reasons: [] };
}
