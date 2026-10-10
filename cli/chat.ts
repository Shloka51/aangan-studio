// Talk to the agent as a caller, in the terminal. Same core as the phone line.
//   npm run chat            (rules brain, or Gemini if GEMINI_API_KEY is set)
//   npm run chat -- --rules (force the offline rules brain)
// Type /end to hang up and see the outcome, handoff note and actions.
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { calcomLink } from "@/adapters/booking/calcom";
import { createBrain } from "@/adapters/brain";
import { Session } from "@/core/session";
import { renderHandoffText } from "@/core/handoff";

async function main() {
  const brain = await createBrain({ live: !process.argv.includes("--rules") });
  const s = Session.start(
    { id: `chat-${Date.now()}`, channel: "phone", caller: { number: "+91 90000 00000" }, receivedAt: new Date().toISOString(), status: "answered", turns: [] },
    { brain, bookingLink: calcomLink },
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`(brain: ${process.env.GEMINI_API_KEY && !process.argv.includes("--rules") ? "gemini" : "rules"} — type /end to hang up)\n`);
  console.log(`Agent: ${await s.greet()}`);
  process.stdout.write("You:   ");
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/end") break;
    if (line) {
      if (!process.stdin.isTTY) console.log(line);
      const t = await s.onCallerTurn(line);
      console.log(`Agent: ${t.reply}${s.state.transcript.at(-1)?.guardrail ? "   [guardrail rewrote the model's reply]" : ""}`);
    }
    process.stdout.write("You:   ");
  }
  rl.close();
  const r = s.finalize();
  console.log(`\nOutcome: ${r.outcome.kind}${r.outcome.declineReason ? ` (${r.outcome.declineReason})` : ""} — ${r.outcome.nextStep}`);
  for (const c of r.qualification.criteria) console.log(`  ${c.status.padEnd(9)} ${c.id}. ${c.name}: ${c.reason}`);
  if (r.handoffNote) console.log(`\n${renderHandoffText(r.handoffNote)}`);
  console.log(`\nActions: ${r.actions.map((a) => a.type).join(", ")}`);
  if (r.usage.length) console.log(`Cost: ₹${r.usage.reduce((a, u) => a + u.costInr, 0).toFixed(3)}`);
}
main();
