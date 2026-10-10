// Resend email handoff (secondary channel).
import type { Transport } from "./telegram";

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class ResendTransport implements Transport {
  constructor(
    private apiKey = process.env.RESEND_API_KEY,
    private from = process.env.HANDOFF_EMAIL_FROM || "Aangan Enquiries <onboarding@resend.dev>",
    private to = { designer: process.env.HANDOFF_EMAIL_TO, studio_head: process.env.STUDIO_HEAD_EMAIL || process.env.HANDOFF_EMAIL_TO },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: "designer" | "studio_head", subject: string, body: string) {
    const recipient = this.to[to];
    if (!this.apiKey || !recipient) {
      console.log(`[email:stub → ${to}] ${subject}`);
      return { status: "stubbed" as const };
    }
    try {
      const res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: this.from,
          to: recipient.split(",").map((s) => s.trim()),
          subject,
          text: body,
          html: `<pre style="font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;font-size:13px">${escapeHtml(body)}</pre>`,
        }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { status: "sent" as const };
    } catch (err) {
      return { status: "failed" as const, error: (err as Error).message };
    }
  }
}
