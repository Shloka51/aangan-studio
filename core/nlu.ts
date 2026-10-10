// Natural-language understanding. Two implementations share one interface:
//  - RuleNLU: deterministic regex extraction. Zero network. Used in tests, and as the
//    fallback whenever the model is unavailable.
//  - GeminiNLU (adapters/llm/gemini.ts): model extraction, merged over the rules.
import { isPricingQuestion } from "./guardrail";
import { ADJOINING_AREAS, EXCLUDED_AREAS, OTHER_OUT_OF_AREA, PCMC_AREAS, PUNE_AREAS } from "./knowledge";
import { extractTimeline } from "./timeline";
import type { AreaStatus, Facts, Turn, UsageRecord } from "./types";

export interface NLUInput {
  transcript: Turn[]; // full conversation so far, latest caller turn last
  now: Date;
  known: { callerName?: string };
}

export interface NLU {
  extract(input: NLUInput): Promise<{ facts: Facts; usage?: UsageRecord }>;
}

export function emptyFacts(): Facts {
  return {
    language: "en",
    rooms: [],
    area: "unknown",
    timeline: {},
    decisionMaker: { status: "unclear" },
    intents: { pricingAsked: false, complaint: false, priorFollowUpFailure: false, reconnect: false },
  };
}

/** Strips stage directions such as "(gives number)" or "(line drops)". */
export function cleanUtterance(text: string): string {
  return text
    .replace(/[’‘]/g, "'")
    .replace(/\((?:gives number|line drops|pause|inaudible)[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HINGLISH_MARKERS = /\b(hai|hain|mein|mera|meri|mere|hamara|hamari|humara|karna|karwana|karwani|kitna|kitne|chahiye|aap|aapka|ghar|bhi|kya|nahi|nahin|theek|ji|namaste|namaskar|bata|batao|bataiye|kab|tak|abhi|lagega|kharcha|paisa|haan|accha|achha)\b/gi;

export function detectLanguage(callerText: string): "en" | "hinglish" {
  if (/[ऀ-ॿ]/.test(callerText)) return "hinglish";
  return (callerText.match(HINGLISH_MARKERS)?.length ?? 0) >= 2 ? "hinglish" : "en";
}

const NAME_STOP = new Set(["in", "calling", "just", "the", "doing", "planning", "getting", "looking", "not", "a", "an", "from", "here", "opening", "interested", "fine", "okay", "sorry", "very", "also", "still", "currently", "really", "trying", "having", "going", "back", "with", "on", "at"]);

function extractName(text: string, answeringName: boolean): string | undefined {
  const m = text.match(/\b(?:[Ii]'?m|[Ii] am|[Tt]his is|[Mm]y name is|[Mm]era naam(?: hai)?|[Mm]ain)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  if (m && !NAME_STOP.has(m[1].split(" ")[0].toLowerCase())) return m[1].replace(/\s+(From|Here|And|Calling)$/, "");
  if (answeringName) {
    const bare = text.match(/^\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)[.,]/);
    if (bare && !NAME_STOP.has(bare[1].toLowerCase()) && !/^(Yes|No|Hi|Hello|Sure|Okay|Ok)$/.test(bare[1])) return bare[1];
  }
  return undefined;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finds the caller's site location. Prefers places attached to "my/our ... in X". */
function extractLocation(text: string): { location?: string; area: AreaStatus } {
  const candidates: { name: string; area: AreaStatus; idx: number; score: number }[] = [];
  const add = (names: string[], area: AreaStatus) => {
    for (const name of names) {
      const re = new RegExp(String.raw`\b${escapeRe(name)}\b`, "gi");
      for (const m of text.matchAll(re)) {
        const before = text.slice(Math.max(0, m.index! - 60), m.index);
        const sentenceStart = Math.max(text.lastIndexOf(".", m.index!), text.lastIndexOf("—", m.index!));
        const sentence = text.slice(sentenceStart + 1, m.index! + name.length + 40);
        let score = 1;
        if (/\b(my|our|we have|i have|i'm in|i am in|we're in|mera|hamara|humara|flat|home|apartment|villa|office|house|property|space|site|bhk)\b/i.test(before)) score += 2;
        if (/\b(she|her|his|friend|their)\b/i.test(sentence)) score -= 2;
        candidates.push({ name, area, idx: m.index!, score });
      }
    }
  };
  add(PUNE_AREAS, "listed");
  add(PCMC_AREAS, "listed");
  add(ADJOINING_AREAS, "adjoining");
  add([...EXCLUDED_AREAS, ...OTHER_OUT_OF_AREA], "out");
  if (!candidates.length) {
    if (/\bpune\b/i.test(text)) return { location: "Pune", area: "adjoining" };
    if (/\bpcmc\b|pimpri[- ]chinchwad/i.test(text)) return { location: "PCMC", area: "listed" };
    return { area: "unknown" };
  }
  // Longest name wins at the same index (e.g. "Talegaon Dabhade" over "Talegaon").
  candidates.sort((a, b) => b.score - a.score || b.idx - a.idx || b.name.length - a.name.length);
  const best = candidates[0];
  return { location: best.name, area: best.area };
}

const ROOM_PATTERNS: [string, RegExp][] = [
  ["kitchen", /\b(modular )?kitchen|rasoi\b/i],
  ["living room", /\bliving( room| area)?|hall\b/i],
  ["bedrooms", /\b(bed ?rooms?|master bedroom)\b/i],
  ["wardrobes", /\bwardrobes?\b/i],
  ["dining", /\bdining\b/i],
  ["study", /\bstudy\b/i],
  ["home office", /\bhome office\b/i],
  ["flooring", /\bflooring\b/i],
];

function extractRooms(text: string): string[] {
  return ROOM_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
}

function parseInr(num: string, unit: string): number {
  const n = Number(num.replace(/,/g, ""));
  const u = unit.toLowerCase();
  if (/^(lakh|lakhs|lac|lacs|l)$/.test(u)) return n * 100_000;
  if (/^(crore|crores|cr)$/.test(u)) return n * 10_000_000;
  if (/^(k|thousand|hazaar|hazar)$/.test(u)) return n * 1000;
  return n;
}

function extractBudget(text: string): Facts["budget"] {
  const re = /(?:₹|rs\.?\s*|inr\s*)?(\d+(?:[.,]\d+)?)\s*(?:(?:to|-|–|se)\s*(?:₹|rs\.?\s*)?(\d+(?:[.,]\d+)?)\s*)?(lakhs?|lacs?|crores?|cr|k|thousand|hazaar)\b/i;
  const m = text.match(re);
  if (!m || !/budget|afford|spend|max|maximum|lakh|lac|crore|kharcha/i.test(text)) return undefined;
  const hi = m[2] ?? m[1];
  return { raw: m[0].trim(), maxInr: parseInr(hi, m[3]) };
}

/** Deterministic extractor over the whole transcript so far. */
export class RuleNLU implements NLU {
  async extract({ transcript, now, known }: NLUInput) {
    return { facts: extractFactsByRules(transcript, now, known) };
  }
}

export function extractFactsByRules(transcript: Turn[], now: Date, known: { callerName?: string } = {}): Facts {
  const f = emptyFacts();
  const callerTurns: { text: string; prevAgent?: Turn }[] = [];
  let prevAgent: Turn | undefined;
  for (const t of transcript) {
    if (t.speaker === "agent") prevAgent = t;
    else callerTurns.push({ text: cleanUtterance(t.text), prevAgent });
  }
  const all = callerTurns.map((c) => c.text).join(" \n ");
  const latest = callerTurns.at(-1)?.text ?? "";

  f.language = detectLanguage(all);
  f.callerName = known.callerName;
  for (const c of callerTurns) {
    const name = extractName(c.text, c.prevAgent?.action === "ask_name" || c.prevAgent?.action === "escalate" || c.prevAgent?.action === "recover_apology");
    if (name && !f.callerName) f.callerName = name;
  }

  // ---- Location / size / property ----
  Object.assign(f, extractLocation(all));
  const sq = all.match(/(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|square feet|sft)/i);
  if (sq) f.sqft = Number(sq[1].replace(/,/g, ""));
  const bhk = all.match(/\b(\d)\s*-?\s*bhk\b/i);
  if (bhk) f.property = `${bhk[1]}BHK`;
  else if (/\bvilla\b/i.test(all)) f.property = "villa";
  else if (/\bindependent house|bungalow\b/i.test(all)) f.property = "independent house";
  else if (/\bpod\b/i.test(all)) f.property = "pod";
  f.rooms = extractRooms(all);
  f.rented = /\brent(ed|al)?\b|\blease\b|\blandlord\b|kiraye/i.test(all) || undefined;
  f.siteVisitRequested = /site visit|come to (the )?site|visit the (site|flat)/i.test(all) || undefined;
  const ref = all.match(/(?:from a friend|friend)\s*[—-]\s*([A-Z][a-z]+ [A-Z][a-z]+)|([A-Z][a-z]+ [A-Z][a-z]+) asked me to call/);
  if (ref) f.referral = ref[1] ?? ref[2];
  else if (/instagram|linkedin|google|referr|recommend/i.test(all)) f.referral = all.match(/instagram|linkedin|google/i)?.[0];

  // ---- Segment / out-of-scope ----
  if (/\brestaurant|caf[eé]|bistro|bar and grill|eatery|cloud kitchen\b/i.test(all)) f.outOfScope = "restaurant";
  else if (/\bhotel|resort|guest ?house|homestay\b/i.test(all)) f.outOfScope = "hotel";
  else if (/\b(retail|showroom|boutique|shop|store)\b/i.test(all)) f.outOfScope = "retail";
  else if (/\bgym|fitness (studio|centre|center)|crossfit\b/i.test(all)) f.outOfScope = "gym";
  else if (/\bvastu\b/i.test(all) && /\bonly|just\b/i.test(all) && !/design/i.test(all)) f.outOfScope = "vastu_only";
  else if (/\b(just|only) (need |want )?(to )?(buy|source|procure) furniture\b/i.test(all)) f.outOfScope = "furniture_only";
  else if (
    /\b(move|break|remove|knock(ing)? down|shift)\s+(a |the |some )?walls?\b|\bstructural (work|changes)\b|\bbuilding permit/i.test(all) &&
    !/\b(no|not|without|don't|never)\b[^.]{0,20}\b(structural|walls?|wall-breaking)/i.test(all)
  )
    f.outOfScope = "architecture";

  const commercial = /\b(office|commercial|startup|workstations?|co-?working|clinic|cabins?)\b/i.test(all.replace(/home office/gi, ""));
  f.segment = f.outOfScope && ["restaurant", "hotel", "retail", "gym"].includes(f.outOfScope) ? "commercial" : commercial ? "commercial" : f.property || f.rooms.length ? "residential" : undefined;

  // ---- Criterion 1: real project vs advice ----
  const adviceRe = /\b(some ideas|give us (some )?ideas|just (want|looking for) (some )?(ideas|suggestions|advice)|suggestions on|advise|advice only|second opinion|not planning to do the full thing|just exploring|only exploring|i'?ll do the execution myself|we'?ll do the execution|sirf (idea|salah|advice))\b/i;
  f.adviceOnly = adviceRe.test(all) || undefined;
  const execRe = /\b(redo|redesign|re-design|complete (re)?design|full (re)?design|whole thing|full home|full package|end[- ]to[- ]end|full interiors?|do the interiors|interiors? (project|done)|properly (do|design)|proper design|fit ?out|fitout|execution|design and fittings|poora ghar|interior (design )?karwana|from scratch|need workstations)\b/i;
  f.wantsExecution = execRe.test(all) || (f.rooms.length >= 2 && !f.adviceOnly) || undefined;

  // ---- Project type ----
  if (f.segment === "commercial") f.projectType = "office";
  else if (/\b(whole thing|complete redesign|full redesign|full home|full package|end[- ]to[- ]end|entire (flat|home|house)|poora ghar|full interiors?|all four bedrooms)\b/i.test(all) || (f.rooms.includes("kitchen") && f.rooms.length >= 3))
    f.projectType = "full_home";
  else if (f.rooms.filter((r) => r !== "flooring").length >= 2) f.projectType = "partial";
  else if (f.rooms.length === 1) f.projectType = "single_room";
  else if (f.property && /proper design|interiors?|design/i.test(all)) f.projectType = "full_home";

  // ---- Timeline (turn by turn, so a bare "March" after our question counts) ----
  for (const c of callerTurns) {
    const tl = extractTimeline(c.text, now, c.prevAgent?.action === "ask_timeline");
    const { deferAfterEvent, ...rest } = tl;
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && (f.timeline as Record<string, unknown>)[k] === undefined) (f.timeline as Record<string, unknown>)[k] = v;
    if (deferAfterEvent) f.intents.deferAfterEvent = true;
  }

  // ---- Criterion 5: decision maker ----
  if (/\b(for my|on behalf of( my)?|my) (parents|mother|father|mom|dad|in-?laws|sister|brother|boss|client)\b/i.test(all) && /\b(they'?ll decide|they decide|their (flat|home|house)|they have|parents have|for my parents)\b/i.test(all)) {
    const attend = /\b(they would come|they'?ll come|they will (come|attend)|both will attend|will be at the consultation)\b/i.test(all);
    f.decisionMaker = { status: attend ? "represented" : "unclear", note: attend ? "Calling for family; owners will attend the consultation and decide." : "Calling for family; owners' authorisation not confirmed." };
  } else if (/\b(just doing (some )?(initial )?research|just checking for (someone|a friend)|not my decision)\b/i.test(all)) {
    f.decisionMaker = { status: "unclear", note: "Caller is researching on someone else's behalf." };
  } else if (/\b(i'?m the (owner|founder|director|ceo|decision[- ]maker)|myself and my (husband|wife|partner)|my (husband|wife|partner) and i|i own|we own|happy to go ahead|said to go ahead)\b/i.test(all)) {
    const spouse = all.match(/\b(husband|wife|partner)\b/i)?.[0];
    f.decisionMaker = { status: "self", note: spouse ? `Caller and ${spouse} are the owners; ${spouse} is aware/agreed.` : "Caller is the decision-maker." };
  } else if (/\b(i have|we have|my|our|mera|hamara)\b[^.]{0,30}\b(\dbhk|flat|home|apartment|villa|house|office|space|place)\b|\bwe'?ve been here\b|\bi'?ve been here\b/i.test(all)) {
    f.decisionMaker = { status: "self", note: f.rented ? "Tenant with landlord's consent for non-structural work." : "Caller speaks as the owner/occupant." };
  }

  // ---- Budget (only if volunteered) ----
  f.budget = extractBudget(all);

  // ---- Intents ----
  f.intents.pricingAsked = isPricingQuestion(latest);
  f.intents.complaint =
    /\b(my|our) (project|designer|site work)\b[^.]{0,80}\b(going|been|hasn'?t|not|no one|delay|stuck|unacceptable)\b|\bmy designer is\b|\bnot acceptable\b|\bcomplaint\b|\bmera project\b/i.test(all) &&
    !/\b(new|first) project\b/i.test(all);
  f.intents.reconnect = /\b(got cut off|call (got )?(dropped|disconnected|cut)|line dropped|called just now)\b/i.test(all);
  f.intents.priorFollowUpFailure =
    /\b(i'?d called|i had called|i called|i messaged|maine call kiya tha)\b[^.]{0,40}\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|last week|earlier|days ago|before)\b/i.test(all) &&
    /\b(get back|got back|call(ed)? back|no one|nobody|haven'?t heard|been (two|three|\d+) days|no follow|never heard)\b/i.test(all);
  return f;
}
