// Picks the brain: Gemini when a key is configured, otherwise the deterministic rules.
import { TemplateNLG } from "@/core/nlg";
import { RuleNLU } from "@/core/nlu";
import type { Brain } from "@/core/session";

export function rulesBrain(): Brain {
  return { nlu: new RuleNLU(), nlg: new TemplateNLG() };
}

export async function createBrain(opts: { live?: boolean } = {}): Promise<Brain> {
  if (opts.live !== false && process.env.GEMINI_API_KEY) {
    const { geminiBrain } = await import("./llm/gemini");
    return geminiBrain();
  }
  return rulesBrain();
}
