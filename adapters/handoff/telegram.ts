// Telegram Bot API handoff (primary channel). Plain text, no parse_mode, so caller
// words never break Markdown/HTML escaping. Long notes are split at 4,000 chars.
export interface Transport {
  send(to: "designer" | "studio_head", subject: string, body: string): Promise<{ status: "sent" | "stubbed" | "failed"; error?: string }>;
}

const LIMIT = 4000;

export function splitMessage(text: string, limit = LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit) > limit / 2 ? rest.lastIndexOf("\n", limit) : limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return [...parts, rest];
}

export class TelegramTransport implements Transport {
  constructor(
    private token = process.env.TELEGRAM_BOT_TOKEN,
    private chats = { designer: process.env.TELEGRAM_DESIGNER_CHAT_ID, studio_head: process.env.TELEGRAM_STUDIO_HEAD_CHAT_ID || process.env.TELEGRAM_DESIGNER_CHAT_ID },
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: "designer" | "studio_head", subject: string, body: string) {
    const chatId = this.chats[to];
    if (!this.token || !chatId) {
      console.log(`[telegram:stub → ${to}] ${subject}`);
      return { status: "stubbed" as const };
    }
    try {
      for (const text of splitMessage(`${subject}\n\n${body}`)) {
        const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        if (!res.ok) throw new Error(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      return { status: "sent" as const };
    } catch (err) {
      return { status: "failed" as const, error: (err as Error).message };
    }
  }
}
