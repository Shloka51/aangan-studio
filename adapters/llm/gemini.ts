// Gemini brain (@google/generative-ai). Two small calls per caller turn:
//   NLU: structured extraction (JSON schema), merged over the deterministic rules.
//   NLG: words the action the policy chose, under the composed system prompt.
// The model never decides the outcome, and every reply still passes the pricing guardrail.
// Any model error or timeout falls back to rules/templates, so a call never stalls.
import { GoogleGenerativeAI, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { renderTemplate, type NLG, type NLGInput } from "@/core/nlg";
import { extractBudget, extractFactsByRules, extractLocation, type NLU, type NLUInput } from "@/core/nlu";
import { buildSystemPrompt } from "@/core/prompt";
import type { Brain } from "@/core/session";
import type { Facts, ProjectType, Turn, UsageRecord } from "@/core/types";

const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 4000);

export function costInr(inputTokens: number, outputTokens: number): number {
  const inUsd = Number(process.env.GEMINI_USD_PER_M_INPUT ?? 0.3);
  const outUsd = Number(process.env.GEMINI_USD_PER_M_OUTPUT ?? 2.5);
  const fx = Number(process.env.USD_TO_INR ?? 88);
  return ((inputTokens * inUsd + outputTokens * outUsd) / 1_000_000) * fx;
}

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`gemini timeout ${ms}ms`)), ms))]);
}

function client() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenerativeAI(key);
}
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
let retired = new Set<string>();
const modelName = () => {
  const m = (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();
  return retired.has(m) ? DEFAULT_MODEL : m;
};

/** Runs a model call; if Google says the configured model is retired, retries once on the default. */
async function withModelFallback<T>(call: (model: string) => Promise<T>): Promise<T> {
  const model = modelName();
  try {
    return await call(model);
  } catch (err) {
    const msg = (err as Error).message;
    if (model !== DEFAULT_MODEL && /no longer available|not found for API version|models\/[\w.-]+ is not found/i.test(msg)) {
      console.warn(`[gemini] ${model} unavailable, using ${DEFAULT_MODEL}`);
      retired = new Set([...retired, model]);
      return call(DEFAULT_MODEL);
    }
    throw err;
  }
}

const S = SchemaType;
const str = (description: string) => ({ type: S.STRING, description, nullable: true });
const bool = (description: string) => ({ type: S.BOOLEAN, description, nullable: true });

// Literal types widen inside nested object literals, so the schema is cast once here.
const EXTRACTION_SCHEMA = {
  type: S.OBJECT,
  properties: {
    callerName: str("Caller's own name if they said it"),
    language: { type: S.STRING, enum: ["en", "hinglish"], format: "enum", description: "hinglish if the caller uses Hindi or mixes Hindi/English" },
    location: str("Locality/city of the SITE (not where a friend lives), e.g. 'Kothrud', 'Nashik'"),
    projectType: { type: S.STRING, enum: ["full_home", "partial", "single_room", "office"], format: "enum", nullable: true },
    property: str("e.g. '3BHK', 'villa', 'office', 'pod'"),
    rooms: { type: S.ARRAY, items: { type: S.STRING }, description: "rooms/areas in scope, e.g. kitchen, living room, bedrooms, wardrobes" },
    sqft: { type: S.NUMBER, nullable: true, description: "Approx carpet area in sq ft if stated" },
    wantsExecution: bool("Caller wants design AND execution (a real project)"),
    adviceOnly: bool("Caller only wants ideas/advice/suggestions, or will execute themselves, or is just exploring"),
    outOfScope: { type: S.STRING, enum: ["restaurant", "hotel", "retail", "gym", "architecture", "vastu_only", "furniture_only"], format: "enum", nullable: true },
    commercial: bool("Office/clinic/studio/commercial space"),
    rented: bool("Rented property"),
    deadlineDate: str("ISO date YYYY-MM-DD by which the project must be COMPLETE, if stated. Month only → last day of that month"),
    deadlineEvent: str("Festival/event the deadline refers to, e.g. 'Diwali'"),
    startDate: str("ISO date the caller wants to START, if stated"),
    siteAvailableDate: str("ISO date the site is available (possession/handover); today if already available"),
    noRush: bool("Caller says no rush / flexible"),
    urgent: bool("Caller needs it urgently without a date"),
    decisionMaker: { type: S.STRING, enum: ["self", "represented", "unclear"], format: "enum", description: "self = owner/authorised; represented = calling for owners who will attend/decide; unclear otherwise" },
    decisionMakerNote: str("One short line on who decides"),
    budgetRaw: str("Budget figure ONLY if the caller volunteered one, verbatim"),
    budgetMaxInr: { type: S.NUMBER, nullable: true, description: "Upper end of the volunteered budget in rupees" },
    pricingAskedInLatestTurn: bool("The caller's LATEST turn asks the studio for a cost/price/rate/range/ballpark. false when the caller states their OWN budget figure and asks whether it is enough"),
    existingProjectComplaint: bool("Caller is an existing client complaining about their ongoing project"),
    priorFollowUpFailure: bool("Caller enquired before and nobody got back to them"),
    reconnect: bool("Caller says their previous call just got cut off"),
    deferAfterEvent: bool("Caller proposes starting after their deadline/event instead"),
  },
  required: ["language", "rooms", "decisionMaker"],
} as unknown as ResponseSchema;

type Extraction = Record<string, unknown> & { rooms?: string[] };

export class GeminiNLU implements NLU {
  async extract(input: NLUInput): Promise<{ facts: Facts; usage?: UsageRecord }> {
    const rules = extractFactsByRules(input.transcript, input.now, input.known);
    try {
      const convo = input.transcript.map((t) => `${t.speaker === "agent" ? "Agent" : "Caller"}: ${t.text}`).join("\n");
      const res = await withModelFallback((name) => {
        const model = client().getGenerativeModel({
        model: name,
        systemInstruction: "You extract structured facts from a phone enquiry to an interior-design studio in Pune. Only use what the caller actually said. Use null when unknown. Never invent figures.",
        generationConfig: { responseMimeType: "application/json", responseSchema: EXTRACTION_SCHEMA, temperature: 0 },
        });
        return withTimeout(model.generateContent(`Today is ${input.now.toISOString().slice(0, 10)}.\n\nConversation so far:\n${convo}`));
      });
      const x = JSON.parse(res.response.text()) as Extraction;
      const u = res.response.usageMetadata;
      return { facts: mergeFacts(rules, x, input.transcript), usage: usageRecord("nlu", u?.promptTokenCount ?? 0, outputTokens(u)) };
    } catch (err) {
      console.warn("[gemini nlu] falling back to rules:", (err as Error).message);
      return { facts: rules };
    }
  }
}

/** Model facts override rules where present; safety-relevant intents are OR-ed. */
export function mergeFacts(rules: Facts, x: Extraction, transcript: Turn[] = []): Facts {
  const f: Facts = structuredClone(rules);
  const s = (k: string) => (typeof x[k] === "string" && x[k] ? (x[k] as string) : undefined);
  const b = (k: string) => (typeof x[k] === "boolean" ? (x[k] as boolean) : undefined);
  f.callerName = s("callerName") ?? f.callerName;
  if (s("language")) f.language = s("language") as Facts["language"];
  const loc = s("location");
  if (loc) {
    const area = extractLocation(loc);
    f.location = area.location ?? loc;
    f.area = area.area === "unknown" ? "unknown" : area.area;
  }
  f.projectType = (s("projectType") as ProjectType | undefined) ?? f.projectType;
  f.property = s("property") ?? f.property;
  if (x.rooms?.length) f.rooms = x.rooms;
  if (typeof x.sqft === "number" && x.sqft > 0) f.sqft = x.sqft;
  f.wantsExecution = b("wantsExecution") ?? f.wantsExecution;
  f.adviceOnly = b("adviceOnly") || f.adviceOnly;
  f.outOfScope = (s("outOfScope") as Facts["outOfScope"]) ?? f.outOfScope;
  if (b("commercial") || f.outOfScope) f.segment = "commercial";
  else if (b("commercial") === false && (f.property || f.rooms.length)) f.segment = "residential";
  if (f.segment === "commercial" && !f.outOfScope) f.projectType = "office";
  f.rented = b("rented") ?? f.rented;
  const t = f.timeline;
  t.deadline = s("deadlineDate") ?? t.deadline;
  t.deadlineEvent = s("deadlineEvent") ?? t.deadlineEvent;
  if (s("deadlineDate") && !t.deadlineRaw) t.deadlineRaw = s("deadlineEvent") ?? s("deadlineDate");
  t.start = s("startDate") ?? t.start;
  t.siteAvailable = s("siteAvailableDate") ?? t.siteAvailable;
  t.noRush = b("noRush") ?? t.noRush;
  t.urgent = b("urgent") ?? t.urgent;
  const dm = s("decisionMaker") as Facts["decisionMaker"]["status"] | undefined;
  if (dm) f.decisionMaker = { status: dm, note: s("decisionMakerNote") ?? f.decisionMaker.note };
  if (s("budgetRaw") || typeof x.budgetMaxInr === "number") f.budget = { raw: s("budgetRaw") ?? f.budget?.raw ?? "", maxInr: (x.budgetMaxInr as number) ?? f.budget?.maxInr };
  // A turn where the caller volunteers their own budget is a budget-sanity turn
  // (qualified.md §4: address it), not a request for our prices.
  const latestCaller = [...transcript].reverse().find((t) => t.speaker === "caller")?.text ?? "";
  const volunteersBudget = !!extractBudget(latestCaller);
  f.intents = {
    pricingAsked: rules.intents.pricingAsked || (!volunteersBudget && !!b("pricingAskedInLatestTurn")),
    complaint: rules.intents.complaint || !!b("existingProjectComplaint"),
    priorFollowUpFailure: rules.intents.priorFollowUpFailure || !!b("priorFollowUpFailure"),
    reconnect: rules.intents.reconnect || !!b("reconnect"),
    deferAfterEvent: rules.intents.deferAfterEvent || b("deferAfterEvent"),
  };
  return f;
}

export class GeminiNLG implements NLG {
  private system = buildSystemPrompt();
  async render(input: NLGInput): Promise<{ text: string; usage?: UsageRecord }> {
    const reference = renderTemplate(input);
    const system = this.system;
    const f = input.facts;
    const prompt = `NEXT_ACTION: ${input.action.kind}${input.action.declineReason ? ` (reason: ${input.action.declineReason})` : ""}
Caller language: ${f.language}
Known so far: ${JSON.stringify({ name: f.callerName, location: f.location, projectType: f.projectType, rooms: f.rooms, timeline: f.timeline.deadlineRaw ?? f.timeline.startRaw })}
Studio-approved reference wording for this action (keep its meaning and any commitments; you may adapt it to the conversation and the caller's language):
"${reference}"

Write only the receptionist's next spoken reply.`;
    const res = await withModelFallback((name) =>
      withTimeout(client().getGenerativeModel({ model: name, systemInstruction: system, generationConfig: { temperature: 0.4, maxOutputTokens: 200 } }).generateContent(prompt)),
    );
    const u = res.response.usageMetadata;
    return { text: res.response.text().trim().replace(/^"|"$/g, ""), usage: usageRecord("nlg", u?.promptTokenCount ?? 0, outputTokens(u)) };
  }
}

/** Output tokens billed, including hidden "thinking" tokens on newer models. */
function outputTokens(u: { candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined): number {
  return (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0);
}

function usageRecord(purpose: "nlu" | "nlg", inputTokens: number, outputTokens: number): UsageRecord {
  return { provider: "gemini", model: modelName(), purpose, inputTokens, outputTokens, costInr: costInr(inputTokens, outputTokens) };
}

export function geminiBrain(): Brain {
  return { nlu: new GeminiNLU(), nlg: new GeminiNLG() };
}
