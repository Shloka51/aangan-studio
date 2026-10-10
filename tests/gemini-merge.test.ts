// The Gemini merge layer, tested with canned model output (no network).
import { describe, expect, it } from "vitest";
import { mergeFacts } from "@/adapters/llm/gemini";
import { extractFactsByRules } from "@/core/nlu";
import type { Turn } from "@/core/types";

const now = new Date("2026-09-11T14:04:00+05:30");
const turns = (text: string): Turn[] => [{ speaker: "caller", text }];

describe("mergeFacts", () => {
  it("a volunteered budget + 'is that possible?' is not a pricing question", () => {
    const t = turns("I have a 1BHK in Kharadi. My budget is 1 to 1.5 lakh maximum. Is that possible with you?");
    const f = mergeFacts(extractFactsByRules(t, now), { pricingAskedInLatestTurn: true, rooms: [] }, t);
    expect(f.intents.pricingAsked).toBe(false);
  });

  it("the model can add a pricing question the rules missed", () => {
    const t = turns("Roughly what would something like that set me back?");
    const f = mergeFacts(extractFactsByRules(t, now), { pricingAskedInLatestTurn: true, rooms: [] }, t);
    expect(f.intents.pricingAsked).toBe(true);
  });

  it("the model can never switch off a pricing question the rules caught", () => {
    const t = turns("How much per sq ft do you charge?");
    const f = mergeFacts(extractFactsByRules(t, now), { pricingAskedInLatestTurn: false, rooms: [] }, t);
    expect(f.intents.pricingAsked).toBe(true);
  });

  it("re-checks the model's location against the service-area lists", () => {
    const t = turns("We have a flat near the highway.");
    expect(mergeFacts(extractFactsByRules(t, now), { location: "Talegaon Dabhade", rooms: [] }, t)).toMatchObject({ location: "Talegaon Dabhade", area: "out" });
    expect(mergeFacts(extractFactsByRules(t, now), { location: "Baner", rooms: [] }, t)).toMatchObject({ area: "listed" });
  });
});
