// Natural-language generation. TemplateNLG is deterministic and uses the studio's
// own wording from the transcripts; GeminiNLG (adapters/llm/gemini.ts) words the same
// action more naturally. Both outputs go through the pricing guardrail.
import { STUDIO } from "./config";
import { deflection } from "./guardrail";
import { MULTI_FAIL_DECLINE } from "./knowledge";
import type { AgentAction, Facts, Language, UsageRecord } from "./types";

export interface NLGInput {
  action: AgentAction;
  facts: Facts;
  bookingUrl?: string;
}

export interface NLG {
  render(input: NLGInput): Promise<{ text: string; usage?: UsageRecord }>;
}

const monthName = (iso?: string) =>
  iso ? new Date(iso + "T00:00:00Z").toLocaleString("en-IN", { month: "long", timeZone: "UTC" }) : undefined;

function declineText(f: Facts, a: AgentAction, lang: Language): string {
  const hi = lang === "hinglish";
  switch (a.declineReason) {
    case "out_of_area": // T03
      return hi
        ? "Call karne ke liye shukriya. Hum abhi sirf Pune aur PCMC mein kaam karte hain — Pune ke bahar hamara vendor network nahi hai. Agar kabhi Pune ya PCMC mein project ho, toh zaroor call kijiye."
        : "Thank you for calling. We only work in Pune and PCMC at the moment — we don't have the vendor network to take on projects outside Pune. If you ever have a project in Pune or PCMC, we'd love to hear from you.";
    case "advice_only": // T04
      return hi
        ? "Hum full-service studio hain — hamare projects mein design aur execution dono saath hote hain. Sirf advisory visits hum nahi karte. Jab aap full project ke liye ready hon, toh zaroor call kijiye."
        : "We're a full-service studio — our projects include design and execution together. We don't do advisory or consultation-only visits. Feel free to call back when you're ready to go ahead with a full project.";
    case "out_of_scope_type": // T19
      return hi
        ? "Aapne reach out kiya, shukriya. Ye type ka space hamare current scope ke bahar hai — hum residential aur office spaces par focus karte hain. Pune mein is type ke specialist interior designers aapke liye zyada relevant rahenge."
        : f.outOfScope === "restaurant" || f.outOfScope === "hotel"
          ? "We appreciate you reaching out. Restaurant and hospitality interiors are outside our current scope — we focus on residential and office spaces. Searching for hospitality interior designers in Pune would give you more relevant options."
          : "We appreciate you reaching out. That kind of space is outside our current scope — we focus on residential and office interiors. A specialist studio for that type of space would serve you better.";
    case "below_min_commercial": // T18
      return hi
        ? "Itna chhota commercial space hamare minimum scope se kam hai — hamari team ek certain scale ke liye set up hai. Main suggest karungi ki aap kisi local designer se baat karein jo chhote commercial spaces mein specialise karte hain."
        : "A space that size is below the minimum scope for our commercial projects — our design and execution team is set up for a certain scale. I'd suggest a local designer who specialises in smaller commercial spaces.";
    case "above_max_commercial":
      return "A commercial space that size is beyond the scale we take on — our office projects go up to a mid-sized floor. A larger commercial fit-out firm would serve you better, and we're happy to help with any residential project in future.";
    case "budget_mismatch": // T10 — never echo the caller's figure
      return hi
        ? "Batane ke liye shukriya. Full execution ke saath — materials, furniture aur contractor work — aapka mentioned budget is scope ke liye hamare saath kaafi kam padega. Main aapko consultation par nahi bulana chahungi agar numbers align nahi hote. Aap local contractors se baat kar sakte hain jo is range mein kaam karte hain."
        : "I appreciate you sharing that. For that scope with full execution — materials, furniture, and contractor work — the budget you mentioned would be significantly below what a project of that scope would cost with us. I wouldn't want to bring you to a consultation if the numbers don't align. I'd suggest checking with local contractors who work at that price point.";
    case "impossible_timeline": { // T07
      const event = f.timeline.deadlineEvent;
      return hi
        ? `${event ?? "Aapki date"} bahut paas hai. Hamara design phase hi 3–4 hafte leta hai, phir execution. Itne kam time mein hum project ke saath nyaay nahi kar paayenge. ${event ? `${event} ke baad start karna` : "Thoda baad start karna"} achha rahega — kya main aapki details uske liye note kar loon?`
        : `${event ? `${event} is` : "That date is"} too close — our design phase alone takes 3–4 weeks, and execution follows. We couldn't do justice to a project in that time. ${event ? `A start after ${event}` : "A later start"} would work well — shall I note your details for that?`;
    }
    default:
      return hi
        ? "Lagta hai abhi ye hamare liye sahi fit nahi hai — lekin agar aapki timeline ya scope badle, toh zaroor reach out kijiye."
        : MULTI_FAIL_DECLINE;
  }
}

export function renderTemplate({ action: a, facts: f, bookingUrl }: NLGInput): string {
  const hi = f.language === "hinglish";
  const name = f.callerName ? (hi ? ` ${f.callerName} ji` : ` ${f.callerName}`) : "";
  switch (a.kind) {
    case "greet":
      return hi ? "Namaste, Aangan Studio. Main aapki kaise madad kar sakti hoon?" : "Hello, Aangan Studio. How can I help you today?";
    case "ask_scope":
      return hi
        ? "Aap design ke saath full execution chahte hain, ya sirf design advice?"
        : "Are you looking for full design and execution, or design advice only?";
    case "ask_location":
      return hi ? "Site kis area mein hai?" : "Which area is the site in?";
    case "ask_timeline":
      return hi ? "Aapko project kab tak complete chahiye?" : "When would you need the project complete?";
    case "ask_name":
      return hi ? "Kya main aapka naam jaan sakti hoon?" : "Can I take your name, please?";
    case "deflect_pricing":
      return deflection(f.language);
    case "recover_apology": // T16
      return hi
        ? "Main maafi chahti hoon — aapko wapas call aana chahiye tha. Kya main aapka naam le sakti hoon? Main abhi seedha consultation book kar deti hoon taaki ye dobara na ho."
        : "I'm very sorry — someone should have called you back. Can I get your name? I'll book the consultation directly now so it doesn't slip again.";
    case "offer_booking":
      return hi
        ? `Ye hamare liye achha scope hai${name}. Kya main aapke liye designer ke saath free consultation book kar doon?${f.callerName ? "" : " Aapka naam bhi bata dijiye."}`
        : `That sounds like a good fit for us${name}. Shall I set up a free consultation with one of our designers?${f.callerName ? "" : " And may I have your name for the booking?"}`;
    case "confirm_booking":
      return hi
        ? `Perfect${name}. Main aapko is number par booking link bhej rahi hoon — usme apna convenient slot chun lijiye. Designer aapke project ki poori details ke saath taiyaar rahenge.`
        : `Perfect${name}. I'm sending a booking link to this number so you can pick a slot that suits you${bookingUrl ? "" : ""}. Your designer will have all the details we discussed.`;
    case "decline":
      return declineText(f, a, f.language);
    case "offer_deferred_start": { // T07 "A November start would work well"
      const m = monthName(f.timeline.start);
      return hi
        ? `${m ? `${m} start` : "Baad mein start"} bilkul kaam karega. Main aapki details uske liye note kar leti hoon, aur hum aapko time par call karenge.`
        : `${m ? `A ${m} start` : "A later start"} would work well. I'll note your details for that, and we'll call you in time to begin.`;
    }
    case "escalate": // T09
      return hi
        ? `Mujhe bahut afsos hai. Main ise abhi studio head tak pahuncha rahi hoon — Nikhil ya koi senior person ${STUDIO.escalationCallbackMinutes} minute mein aapko call karenge. Kya main aapka naam aur project ki details le sakti hoon?`
        : `I'm very sorry. I'm getting this to our studio head right now — Nikhil or a senior person will call you back within ${STUDIO.escalationCallbackMinutes} minutes. Can I take your name and project details?`;
    case "acknowledge":
      if (f.intents.complaint)
        return hi
          ? `Note kar liya. Nikhil ya koi senior person ${STUDIO.escalationCallbackMinutes} minute mein call karenge.`
          : `Noted — I'll make sure of that. Nikhil or a senior person will call you back within ${STUDIO.escalationCallbackMinutes} minutes.`;
      if (a.declineReason)
        return hi
          ? "Bilkul samajh sakti hoon. Jab bhi aapka plan badle, humein zaroor call kijiye."
          : "Of course — I understand. Do call us whenever your plans change; we'd be glad to help.";
      return hi ? "Shukriya! Booking link aapko bhej diya hai. Aapka din shubh ho." : "Thank you! The booking link is on its way. Have a lovely day.";
  }
}

export class TemplateNLG implements NLG {
  async render(input: NLGInput) {
    return { text: renderTemplate(input) };
  }
}
