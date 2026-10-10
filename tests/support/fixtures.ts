import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Enquiry } from "@/core/types";

export interface Fixture {
  id: string;
  channel: "phone";
  status: Enquiry["status"];
  receivedAt: string;
  caller: { number: string };
  turns: { speaker: "caller" | "agent"; text: string }[];
  notes: string[];
  header: string;
  expected: { outcome: string; declineReason?: string; recovery?: boolean; pricingAsked?: boolean };
}

export function loadFixtures(): Fixture[] {
  return JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/transcripts.json"), "utf8"));
}

export function toEnquiry(f: Fixture): Enquiry {
  return { id: f.id, channel: f.channel, caller: { number: f.caller.number }, receivedAt: f.receivedAt, status: f.status, turns: f.turns };
}
