// Structured views over the /knowledge markdown. Everything the core needs from
// the studio's documents is parsed here, so the files remain the source of truth.
import { PRICING_MD, QUALIFIED_MD, SERVICES_MD } from "./generated";

export { PRICING_MD, QUALIFIED_MD, SERVICES_MD };

function must<T>(value: T | null | undefined, what: string): T {
  if (value == null) throw new Error(`knowledge: could not parse ${what}`);
  return value;
}

/** The single approved answer to any pricing question (pricing.md, verbatim). */
export const PRICING_DEFLECTION: string = must(
  PRICING_MD.match(/only acceptable response to a pricing question\*\*:\s*"([^"]+)"/)?.[1],
  "pricing deflection",
);

/**
 * Hinglish rendering of the deflection for Hindi/English callers. It says the same
 * thing with no figures. Studio should sign off on this wording before going live.
 */
export const PRICING_DEFLECTION_HINGLISH =
  "Pricing site, aapke chune hue materials aur scope par depend karti hai — aapke designer consultation mein aapko detail mein sab samjhayenge. Agar aap chahein toh main abhi woh consultation book kar sakti hoon.";

export const APPROVED_DEFLECTIONS = [PRICING_DEFLECTION, PRICING_DEFLECTION_HINGLISH];

/** Two-or-more-fails wording from qualified.md. */
export const MULTI_FAIL_DECLINE: string = must(
  QUALIFIED_MD.match(/\*\*Two or more criteria fail\*\*: decline gracefully\. "([^"]+)"/)?.[1],
  "multi-fail decline wording",
);

function splitList(s: string): string[] {
  return s
    .replace(/\band adjoining areas\b/i, "")
    .split(/,|\bor\b|\band\b/)
    .map((x) => x.trim().replace(/\.$/, ""))
    .filter((x) => x && !/other cities/i.test(x));
}

const areaSection = must(SERVICES_MD.match(/## Service area\s+([\s\S]*?)(?=\n## )/)?.[1], "service area");

/** Suburbs named in services.md as inside Pune city. */
export const PUNE_AREAS = splitList(must(areaSection.match(/Pune city \(including ([^)]+)\)/)?.[1], "Pune list"));
/** Suburbs named in services.md as inside PCMC. */
export const PCMC_AREAS = splitList(must(areaSection.match(/PCMC \(([^)]+)\)/)?.[1], "PCMC list"));
/** Places services.md explicitly says we do not serve. */
export const EXCLUDED_AREAS = splitList(
  must(areaSection.match(/We do not currently serve ([^.]+)\./)?.[1], "excluded list"),
);

/**
 * services.md says "and adjoining areas" without naming them. These are Pune city /
 * PCMC localities we treat as adjoining; the handoff note marks them as such so the
 * studio can confirm. Edit this list rather than the matcher.
 */
export const ADJOINING_AREAS = [
  "Kharadi", "Nanded City", "Bavdhan", "Pashan", "Sus", "Balewadi", "Mundhwa", "Yerawada",
  "Wanowrie", "Katraj", "Dhayari", "Sinhagad Road", "Karve Nagar", "Shivajinagar", "Camp",
  "Sadashiv Peth", "Swargate", "Bibwewadi", "Salunkhe Vihar", "Fatima Nagar", "Lohegaon",
  "Dhanori", "Vishrantwadi", "Sunderban", "Cybercity", "Akurdi", "Nigdi",
  "Bhosari", "Moshi", "Tathawade", "Punawale", "Kasarwadi", "Sangvi", "Dange Chowk",
];

/** Other cities/towns we recognise as outside the service area. */
export const OTHER_OUT_OF_AREA = [
  "Talegaon Dabhade", "Chakan", "Lonavala", "Khandala", "Nashik", "Mumbai", "Thane", "Navi Mumbai",
  "Satara", "Kolhapur", "Aurangabad", "Nagpur", "Bangalore", "Bengaluru", "Hyderabad", "Delhi",
  "Goa", "Ahmednagar", "Baramati", "Alibaug", "Panvel",
];

// ---- Internal pricing floors (never surfaced) -----------------------------------

function rupeesToNumber(s: string): number {
  return Number(s.replace(/[,₹\s]/g, ""));
}

/** Lowest residential per-sq-ft figure in pricing.md (standard spec). */
export const RES_MIN_RATE = rupeesToNumber(
  must(PRICING_MD.match(/Standard specification \| ₹([\d,]+)/)?.[1], "residential min rate"),
);
/** Lowest commercial per-sq-ft figure in pricing.md (basic fitout). */
export const COM_MIN_RATE = rupeesToNumber(
  must(PRICING_MD.match(/Basic fitout \| ₹([\d,]+)/)?.[1], "commercial min rate"),
);
/** Lowest single-room all-in figure in pricing.md, in rupees. */
export const SINGLE_ROOM_MIN =
  Number(must(PRICING_MD.match(/Single room redesign \(all-in\): ₹([\d.]+) lakh/)?.[1], "single room min")) * 100000;

/**
 * Every figure that appears in pricing.md, normalised (digits only). The guardrail
 * blocks these in agent output as a last line of defence.
 */
export const PRICING_FIGURES: string[] = Array.from(
  new Set(
    [...PRICING_MD.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g), ...PRICING_MD.matchAll(/–\s?₹?([\d,]+(?:\.\d+)?)/g)]
      .map((m) => m[1].replace(/,/g, ""))
      .filter((x) => x.length >= 1),
  ),
);
