// Turns spoken timeline phrases into dates, relative to when the enquiry arrived.
import { STUDIO } from "./config";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const EVENT_RE = String.raw`(diwali|deepavali|dussehra|dasara|christmas|new year|ganpati|ganesh chaturthi)`;
const WORD_NUM: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  couple: 2, few: 3, ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, chhe: 6,
};

export const DAY_MS = 86_400_000;
export const weeksBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / (7 * DAY_MS);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function monthIndex(token: string): number {
  return MONTHS.findIndex((m) => m.startsWith(token.toLowerCase().slice(0, 3)));
}

/** Next occurrence of a month at/after `now` (same month counts as this year). */
function resolveMonth(token: string, now: Date, nextYearHint: boolean, edge: "start" | "end"): Date {
  const m = monthIndex(token);
  let year = now.getUTCFullYear();
  if (m < now.getUTCMonth() || nextYearHint) year += 1;
  if (nextYearHint && m >= now.getUTCMonth() && year > now.getUTCFullYear() + 1) year -= 1;
  return edge === "start" ? new Date(Date.UTC(year, m, 1)) : new Date(Date.UTC(year, m + 1, 0));
}

function resolveEvent(token: string, now: Date): { date: Date; name: string } | undefined {
  const t = token.toLowerCase();
  const key = /diwali|deepavali/.test(t) ? "diwali" : /dussehra|dasara/.test(t) ? "dussehra" : /ganpati|ganesh/.test(t) ? "ganpati" : t;
  const date = STUDIO.events[key]?.map((d) => new Date(d + "T00:00:00Z")).find((d) => d >= now);
  return date ? { date, name: key[0].toUpperCase() + key.slice(1) } : undefined;
}

function parseCount(token: string): number {
  return /^\d+$/.test(token) ? Number(token) : (WORD_NUM[token.toLowerCase()] ?? NaN);
}

export interface TimelineFacts {
  deadlineRaw?: string;
  deadline?: string;
  deadlineEvent?: string;
  startRaw?: string;
  start?: string;
  siteAvailable?: string;
  noRush?: boolean;
  urgent?: boolean;
  deferAfterEvent?: boolean;
}

/**
 * Extracts timeline facts from one caller utterance.
 * `answeringTimeline` is true when the agent just asked "when do you need it complete?",
 * so a bare "March" is read as a deadline.
 */
export function extractTimeline(text: string, now: Date, answeringTimeline = false): TimelineFacts {
  const out: TimelineFacts = {};
  const t = text.replace(/[’']/g, "'");

  // Possession / handover: site availability, not a deadline.
  const poss = t.match(new RegExp(String.raw`possession[^.]{0,40}?\bin\s+(?:about\s+|around\s+)?(\w+)\s+(weeks?|months?)`, "i"));
  if (poss) {
    const n = parseCount(poss[1]);
    if (!Number.isNaN(n)) out.siteAvailable = iso(new Date(now.getTime() + n * (poss[2].startsWith("week") ? 7 : 30) * DAY_MS));
  } else if (/possession (was|is done|already|last month)|new possession|already (have|got) possession|moved out|bare shell|completely empty|just moved in/i.test(t)) {
    out.siteAvailable = iso(now);
  }

  // Deadlines: "by March", "move in November", "operational by December", "before Diwali".
  const deadlineCue = String.raw`(?:done by|ready by|complete(?:d)? by|finish(?:ed)? by|operational by|move (?:back )?in(?: by)?|moving in(?: by)?|by|before|until|till|tak)`;
  const dm = t.match(new RegExp(String.raw`\b${deadlineCue}\s+(?:the\s+)?(?:end of\s+)?${MONTH_RE}\b(\s+next year|\s+20\d\d)?`, "i"));
  const de = t.match(new RegExp(String.raw`\b(?:by|before|for|in time for|se pehle|pehle)\s+${EVENT_RE}\b|\b${EVENT_RE}\s+(?:se pehle|tak|ke pehle)`, "i"));
  const dmPost = t.match(new RegExp(String.raw`\b${MONTH_RE}(\s+next year)?\s+(?:to move in|move[- ]in|tak)\b`, "i"));
  const rel = t.match(/\b(?:in|within|next)\s+(\w+)\s+(weeks?|months?)\b(?![^.]{0,20}possession)/i);
  const relDur = t.match(/\babout\s+(\w+)\s+months?\.?\s*$/i);

  if (de && !/\bafter\b/i.test(t.slice(0, de.index))) {
    const ev = resolveEvent(de[1] ?? de[2], now);
    if (ev) {
      out.deadline = iso(ev.date);
      out.deadlineEvent = ev.name;
      out.deadlineRaw = de[0];
    }
  } else if (dm) {
    out.deadline = iso(resolveMonth(dm[1], now, /next year/i.test(dm[2] ?? ""), "end"));
    out.deadlineRaw = dm[0];
  } else if (dmPost) {
    out.deadline = iso(resolveMonth(dmPost[1], now, !!dmPost[2], "end"));
    out.deadlineRaw = dmPost[0];
  } else if (rel && !poss && /\b(need|want|done|ready|finish|complete|guests|arriv)/i.test(t)) {
    const n = parseCount(rel[1]);
    if (!Number.isNaN(n)) {
      out.deadline = iso(new Date(now.getTime() + n * (rel[2].startsWith("week") ? 7 : 30) * DAY_MS));
      out.deadlineRaw = rel[0];
    }
  } else if (relDur && answeringTimeline) {
    const n = parseCount(relDur[1]);
    if (!Number.isNaN(n)) out.deadline = iso(new Date(now.getTime() + n * 30 * DAY_MS));
  }

  // Starts: "January start", "starting design from October", "after Diwali".
  const sm = t.match(new RegExp(String.raw`\b(?:start(?:ing)?(?: \w+){0,2} (?:from|in)|from|after)\s+${MONTH_RE}\b|\b${MONTH_RE}\s+start\b`, "i"));
  const se = t.match(new RegExp(String.raw`\b(?:start|starting)?\s*after\s+${EVENT_RE}\b|\b${EVENT_RE}\s+ke baad\b`, "i"));
  if (se) {
    const ev = resolveEvent(se[1] ?? se[2], now);
    if (ev) {
      out.start = iso(new Date(ev.date.getTime() + DAY_MS));
      out.startRaw = se[0].trim();
      out.deferAfterEvent = true;
    }
  } else if (sm) {
    const tok = sm[1] ?? sm[2];
    out.start = iso(resolveMonth(tok, now, false, "start"));
    out.startRaw = sm[0];
  } else if (/\b(start (the design )?(right away|now|immediately)|want to start now|abhi start|turant)\b/i.test(t)) {
    out.start = iso(now);
    out.startRaw = "start now";
  }

  // A bare month as the answer to "when do you need it complete?"
  if (answeringTimeline && !out.deadline && !out.start) {
    const bare = t.match(new RegExp(String.raw`\b${MONTH_RE}\b`, "i"));
    if (bare) {
      out.deadline = iso(resolveMonth(bare[1], now, /next year/i.test(t), "end"));
      out.deadlineRaw = bare[0];
    }
  }

  if (/\b(no rush|flexible|plenty of time|no hurry|koi jaldi nahi|not in a rush)\b/i.test(t)) out.noRush = true;
  if (/\b(urgent|asap|as soon as possible|jaldi|immediately needed|right now)\b/i.test(t) && !/talk|speak/i.test(t)) out.urgent = true;
  return out;
}
