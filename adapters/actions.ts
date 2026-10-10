// Executes the actions the core emitted, against real (or stubbed) adapters, and
// records everything in the store. Swappable transports make this testable offline.
import { ResendTransport } from "@/adapters/handoff/email";
import { TelegramTransport, type Transport } from "@/adapters/handoff/telegram";
import { formatIST } from "@/core/handoff";
import type { EnquiryResult } from "@/core/types";
import type { HandoffRecord, Store } from "@/store";

export interface ActionDeps {
  store: Store;
  telegram?: Transport;
  email?: Transport;
}

export async function executeActions(r: EnquiryResult, deps: ActionDeps): Promise<void> {
  const { store } = deps;
  const telegram = deps.telegram ?? new TelegramTransport();
  const email = deps.email ?? new ResendTransport();
  const id = r.enquiry.id;
  await store.saveResult(r);

  const deliver = async (kind: HandoffRecord["kind"], to: "designer" | "studio_head", subject: string, body: string, note?: HandoffRecord["note"]) => {
    for (const [channel, t] of [["telegram", telegram], ["email", email]] as const) {
      const res = await t.send(to, subject, body);
      await store.recordHandoff({ enquiryId: id, kind, channel, status: res.status, note, body, error: res.error });
    }
  };

  for (const a of r.actions) {
    switch (a.type) {
      case "book_consultation":
        await store.recordBooking(id, a.url);
        break;
      case "send_handoff":
        await deliver("designer", "designer", `${a.note.priority ? "⚠️ " : ""}New ${a.note.qualification} lead: ${a.note.callerName} — ${a.note.projectType}, ${a.note.location}`, a.text, a.note);
        break;
      case "escalate":
        await deliver("escalation", "studio_head", `🚨 ESCALATION — call back within ${a.callbackWithinMinutes} min`, `${a.summary}\n\nCaller: ${a.callerNumber ?? "unknown"}\nReceived: ${formatIST(r.enquiry.receivedAt)}`);
        break;
      case "queue_callback":
        await store.queueCallback({ enquiryId: id, callerNumber: a.callerNumber, kind: "callback", reason: a.reason, dueBy: a.dueBy });
        await deliver("callback_alert", "designer", `📞 Callback needed: ${a.callerNumber ?? "unknown number"}`, `${a.reason}\nDue by: ${formatIST(a.dueBy)}\nReceived: ${formatIST(r.enquiry.receivedAt)}`);
        break;
      case "schedule_followup":
        await store.queueCallback({ enquiryId: id, callerNumber: a.callerNumber, kind: "followup", reason: a.reason, dueBy: new Date(a.date + "T04:30:00Z").toISOString() });
        break;
      case "resolve_callback":
        if (a.callerNumber) await store.resolveCallbacks(a.callerNumber);
        break;
      case "log_decline":
        break; // the outcome row is the log
    }
  }
}
