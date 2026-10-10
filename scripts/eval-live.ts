// Runs T01–T20 through the GEMINI brain (real API calls, costs a few paise) and
// reports label agreement, guardrail rewrites and ₹ cost. Not part of `npm test`.
import "@/cli/env";
import { calcomLink } from "@/adapters/booking/calcom";
import { geminiBrain } from "@/adapters/llm/gemini";
import { findPricingViolations } from "@/core/guardrail";
import { processEnquiry } from "@/core/session";
import { loadFixtures, toEnquiry } from "@/tests/support/fixtures";

async function main() {
  if (!process.env.GEMINI_API_KEY) throw new Error("Set GEMINI_API_KEY in .env first");
  let ok = 0, cost = 0, rewrites = 0, leaks = 0;
  const fixtures = loadFixtures();
  for (const f of fixtures) {
    const e = toEnquiry(f);
    const r = await processEnquiry(e, { brain: geminiBrain(), bookingLink: calcomLink, clock: () => new Date(e.receivedAt) });
    const pass = r.outcome.kind === f.expected.outcome && (!f.expected.declineReason || r.outcome.declineReason === f.expected.declineReason);
    ok += pass ? 1 : 0;
    cost += r.usage.reduce((s, u) => s + u.costInr, 0);
    rewrites += r.guardrailEvents.length;
    leaks += r.transcript.filter((t) => t.speaker === "agent" && findPricingViolations(t.text).length).length;
    console.log(`${pass ? "PASS" : "FAIL"} ${f.id.padEnd(5)} expected ${f.expected.outcome}/${f.expected.declineReason ?? "-"} got ${r.outcome.kind}/${r.outcome.declineReason ?? "-"}  guardrail=${r.guardrailEvents.length}`);
  }
  console.log(`\n${ok}/${fixtures.length} match · guardrail rewrites ${rewrites} · pricing reaching caller ${leaks} · cost ₹${cost.toFixed(2)} (₹${(cost / fixtures.length).toFixed(3)}/enquiry)`);
}
main();
