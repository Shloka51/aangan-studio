// Converts the phone section of knowledge/Aangan_Sep_2026_Enquiries.pdf (text extracted
// to knowledge/enquiries.extracted.txt) into a labelled test set.
// Labels come from the brief + the transcripts' own notes.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const raw = readFileSync(join(root, "knowledge/enquiries.extracted.txt"), "utf8");
const phone = raw.slice(raw.indexOf("T01 ·"), raw.indexOf("SECTION 2"));

type Expected = { outcome: "QUALIFIED" | "DECLINED" | "ESCALATED" | "CALLBACK"; declineReason?: string; recovery?: boolean; pricingAsked?: boolean };
const LABELS: Record<string, Expected> = {
  T01: { outcome: "QUALIFIED" },
  T02: { outcome: "QUALIFIED", pricingAsked: true },
  T03: { outcome: "DECLINED", declineReason: "out_of_area" },
  T04: { outcome: "DECLINED", declineReason: "advice_only" },
  T05: { outcome: "QUALIFIED" },
  T06: { outcome: "QUALIFIED" },
  T07: { outcome: "DECLINED", declineReason: "impossible_timeline" },
  T08: { outcome: "CALLBACK" },
  T09: { outcome: "ESCALATED" },
  T10: { outcome: "DECLINED", declineReason: "budget_mismatch" },
  T11: { outcome: "QUALIFIED" },
  T12: { outcome: "QUALIFIED" },
  T13: { outcome: "QUALIFIED", pricingAsked: true },
  T14: { outcome: "QUALIFIED" },
  T15: { outcome: "QUALIFIED" },
  T16: { outcome: "QUALIFIED", recovery: true },
  T17a: { outcome: "CALLBACK" },
  T17b: { outcome: "QUALIFIED" },
  T18: { outcome: "DECLINED", declineReason: "below_min_commercial" },
  T19: { outcome: "DECLINED", declineReason: "out_of_scope_type" },
  T20: { outcome: "QUALIFIED" },
};

const MONTHS: Record<string, string> = { September: "09", October: "10" };
function toIso(day: string, month: string, time: string): string {
  const m = time.match(/(\d+):(\d+)(am|pm)/)!;
  let h = Number(m[1]) % 12;
  if (m[3] === "pm") h += 12;
  return `2026-${MONTHS[month]}-${day.padStart(2, "0")}T${String(h).padStart(2, "0")}:${m[2]}:00+05:30`;
}

function parseTurns(body: string) {
  const turns: { speaker: "caller" | "agent"; text: string }[] = [];
  const notes: string[] = [];
  let cur: { speaker: "caller" | "agent" | "note"; text: string } | undefined;
  const flush = () => {
    if (!cur) return;
    const text = cur.text.replace(/\s+/g, " ").trim();
    if (cur.speaker === "note") notes.push(text);
    else turns.push({ speaker: cur.speaker, text });
  };
  for (const line of body.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const m = l.match(/^(Front Desk|Caller|Note):\s*(.*)$/);
    if (m) {
      flush();
      cur = { speaker: m[1] === "Caller" ? "caller" : m[1] === "Note" ? "note" : "agent", text: m[2] };
    } else if (cur) cur.text += " " + l;
  }
  flush();
  return { turns, notes };
}

const blocks = phone.split(/\n(?=T\d\d ·)/).map((b) => b.trim());
const fixtures: unknown[] = [];
for (const block of blocks) {
  const [header, ...rest] = block.split("\n");
  const id = header.slice(0, 3);
  const h = header.match(/^T\d\d · Phone · (\d+) (\w+) · (\d+:\d+[ap]m)/)!;
  const receivedAt = toIso(h[1], h[2], h[3]);
  const n = Number(id.slice(1));
  const number = `+91 98220 ${String(10000 + n * 101).slice(-5)}`;
  const body = rest.join("\n");

  if (id === "T17") {
    const [first, second] = body.split(/Second call[^\n]*\n/);
    const a = parseTurns(first.replace(/First call[^\n]*\n/, ""));
    const b = parseTurns(second);
    fixtures.push({ id: "T17a", channel: "phone", status: "dropped", receivedAt, caller: { number }, ...a, header, expected: LABELS.T17a });
    fixtures.push({ id: "T17b", channel: "phone", status: "answered", receivedAt: receivedAt.replace("14:14", "14:16"), caller: { number }, ...b, header, expected: LABELS.T17b });
    continue;
  }
  const missed = /MISSED CALL/.test(header);
  const parsed = missed ? { turns: [], notes: [body.replace(/\s+/g, " ").trim()] } : parseTurns(body);
  fixtures.push({ id, channel: "phone", status: missed ? "missed" : "answered", receivedAt, caller: { number }, ...parsed, header, expected: LABELS[id] });
}

writeFileSync(join(root, "tests/fixtures/transcripts.json"), JSON.stringify(fixtures, null, 2) + "\n");
console.log(`wrote ${fixtures.length} fixtures`);
