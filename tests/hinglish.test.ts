// Synthetic Hindi/English calls (not from the PDF) to cover mixed-language callers.
import { describe, expect, it } from "vitest";
import { PRICING_DEFLECTION_HINGLISH } from "@/core/knowledge";
import { findPricingViolations } from "@/core/guardrail";
import { processEnquiry } from "@/core/session";
import type { Enquiry } from "@/core/types";
import { deps } from "./support/deps";

const call = (id: string, receivedAt: string, lines: string[]): Enquiry => ({
  id, channel: "phone", status: "answered", receivedAt, caller: { number: "+91 90000 00001" },
  turns: lines.map((text) => ({ speaker: "caller", text })),
});

describe("Hindi/English mixed callers", () => {
  it("H01: qualifies a Hinglish caller, deflects pricing in Hinglish, books", async () => {
    const e = call("H01", "2026-10-03T21:30:00+05:30", [
      "Namaste, mera naam Sunil Yadav hai. Mera 3BHK flat hai Pimple Nilakh mein, poora ghar ka interior karwana hai.",
      "Kitna kharcha aayega? Bas ek range bata do.",
      "March tak ho jaana chahiye, koi jaldi nahi hai.",
      "Haan, book kar dijiye.",
    ]);
    const r = await processEnquiry(e, deps(e));
    expect(r.facts.language).toBe("hinglish");
    expect(r.facts.callerName).toBe("Sunil Yadav");
    expect(r.facts.location).toBe("Pimple Nilakh");
    expect(r.transcript[3].text).toBe(PRICING_DEFLECTION_HINGLISH);
    expect(r.outcome.kind).toBe("QUALIFIED");
    expect(r.afterHours).toBe(true);
    for (const t of r.transcript.filter((t) => t.speaker === "agent")) expect(findPricingViolations(t.text)).toEqual([]);
    expect(r.transcript.at(-1)!.text).toMatch(/booking link/);
  });

  it("H02: declines an out-of-area Hinglish caller in Hinglish", async () => {
    const e = call("H02", "2026-10-04T11:00:00+05:30", ["Hello ji, mera flat Lonavala mein hai, 2BHK. Poora interior karwana hai, aap kar sakte hain kya?"]);
    const r = await processEnquiry(e, deps(e));
    expect(r.outcome).toMatchObject({ kind: "DECLINED", declineReason: "out_of_area" });
    expect(r.transcript.at(-1)!.text).toMatch(/sirf Pune aur PCMC/);
  });

  it("H03: Hinglish 'Diwali se pehle' is an impossible timeline", async () => {
    const e = call("H03", "2026-10-01T12:00:00+05:30", ["Mera 2BHK Baner mein hai, kitchen aur living room redo karna hai, Diwali se pehle chahiye."]);
    const r = await processEnquiry(e, deps(e));
    expect(r.outcome).toMatchObject({ kind: "DECLINED", declineReason: "impossible_timeline" });
  });
});
