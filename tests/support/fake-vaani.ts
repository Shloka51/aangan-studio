// A stand-in for Vaani: connects to our call server over a real WebSocket and speaks
// Vaani's BYOL protocol (handshake, response_required with a growing transcript).
import { WebSocket } from "ws";

export interface FakeCallResult {
  handshake: Record<string, unknown>[];
  replies: string[];
  endCall: boolean;
}

export async function fakeVaaniCall(opts: {
  url: string; // ws://host:port/vaani
  callId: string;
  callerLines: string[];
  token?: string;
  greeting?: string;
  systemPrompt?: string;
  reqBody?: Record<string, unknown> | null;
}): Promise<FakeCallResult> {
  const ws = new WebSocket(`${opts.url}/${encodeURIComponent(opts.callId)}`, {
    headers: opts.token ? { Authorization: `Bearer ${opts.token}` } : {},
  });
  const inbox: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    inbox.push(JSON.parse(raw.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (timeoutMs = 20000) => {
    const t0 = Date.now();
    while (!inbox.length) {
      if (Date.now() - t0 > timeoutMs) throw new Error("fake vaani: timed out waiting for a frame");
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 200); });
    }
    return inbox.shift()!;
  };
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });

  const handshake = [await next(), await next()];
  const transcript: { role: string; content: string }[] = [
    { role: "system", content: opts.systemPrompt ?? "Vaani-side prompt (ignored by our server)" },
    { role: "assistant", content: opts.greeting ?? "Hello, Aangan Studio. How can I help you today?" },
  ];
  const replies: string[] = [];
  let endCall = false;
  let id = 0;
  for (const line of opts.callerLines) {
    transcript.push({ role: "user", content: line });
    ws.send(JSON.stringify({ interaction_type: "response_required", response_id: ++id, call_id: opts.callId, transcript, req_body: opts.reqBody ?? null }));
    let text = "";
    for (;;) {
      const f = await next();
      if (f.response_type !== "response" || f.response_id !== id) continue;
      text += String(f.content ?? "");
      if (f.end_call) endCall = true;
      if (f.content_complete) break;
    }
    replies.push(text);
    transcript.push({ role: "assistant", content: text });
  }
  ws.close();
  return { handshake, replies, endCall };
}
