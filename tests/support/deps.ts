import { calcomLink } from "@/adapters/booking/calcom";
import { rulesBrain } from "@/adapters/brain";
import type { NLG } from "@/core/nlg";
import type { Brain, CoreDeps } from "@/core/session";
import type { Enquiry } from "@/core/types";

export function deps(e: Pick<Enquiry, "receivedAt">, brain: Brain = rulesBrain()): CoreDeps {
  return { brain, bookingLink: calcomLink, clock: () => new Date(e.receivedAt) };
}

/** A hostile "model" that leaks prices in every reply. The guardrail must stop all of it. */
export class LeakyNLG implements NLG {
  private i = 0;
  private leaks = [
    "For a 2BHK it's typically ₹18–22 lakh.",
    "Our rates start at 1,800 per sq ft for standard spec.",
    "It'll cost around 15 lakhs, roughly.",
    "Single rooms are about 3.5 to 8 lakh all-in.",
    "Premium offices run ₹2800/sqft.",
    "Kitchen alone would be maybe 4 lac rupees.",
    "Budget ballpark is somewhere between twenty and thirty lakh.",
    "Aapka kharcha lagbhag 20 lakh aayega.",
  ];
  async render() {
    return { text: this.leaks[this.i++ % this.leaks.length] };
  }
}
