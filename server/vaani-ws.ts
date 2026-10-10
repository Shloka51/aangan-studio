// The always-on call server Vaani's "Bring Your Own LLM" connects to.
// Vercel can't hold WebSockets, so this runs separately: on your Mac behind a tunnel for
// testing (`npm run voice-server`), or on a small always-on host for production.
//
//   wss://<host>/vaani/<call_id>   (Vaani appends /<call_id> to the URL you configure)
//   GET /health                    (for hosts and tunnels)
//
// Auth: Vaani sends `Authorization: Bearer <token>` if you set an Auth Token in its BYOL
// tab. Set the same value as VAANI_BYOL_TOKEN here; without it, connections are refused
// in production.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { VaaniCall, handshakeFrames, type VaaniRequest, type VoiceDeps } from "@/adapters/voice/vaani";

export interface VaaniServerOptions extends VoiceDeps {
  token?: string;
  /** Called with each finished call (tests use this to await the handoff). */
  onCallFinished?: (callId: string) => void;
}

function tokenOk(req: IncomingMessage, token?: string): boolean {
  if (!token) return process.env.NODE_ENV !== "production";
  const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createVaaniServer(opts: VaaniServerOptions): Server {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.url === "/health") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    const m = (req.url ?? "").split("?")[0].match(/^\/vaani\/([^/]+)\/?$/);
    if (!m) return socket.destroy();
    if (!tokenOk(req, opts.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onCall(ws, decodeURIComponent(m[1])));
  });

  function onCall(ws: WebSocket, callId: string) {
    const call = new VaaniCall(callId, opts);
    const send = (frames: object[]) => frames.forEach((f) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(f)));
    send(handshakeFrames());
    console.log(`[vaani] call ${callId} connected`);

    ws.on("message", async (raw) => {
      let msg: VaaniRequest;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        send(await call.onFrame(msg));
      } catch (err) {
        console.error(`[vaani] ${callId} turn failed:`, (err as Error).message);
        // Never leave the caller in silence: a safe, price-free line that keeps the call moving.
        send([{ response_type: "response", response_id: msg.response_id ?? 0, content: "Sorry, could you say that once more?", content_complete: true }]);
      }
    });

    ws.on("close", async () => {
      try {
        const r = await call.onClose();
        console.log(`[vaani] call ${callId} ended → ${r.outcome.kind}`);
      } catch (err) {
        console.error(`[vaani] ${callId} finalize failed:`, (err as Error).message);
      } finally {
        opts.onCallFinished?.(callId);
      }
    });
  }

  return server;
}

// ---- CLI entry: `npm run voice-server` -----------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await import("@/cli/env");
    const { createBrain } = await import("@/adapters/brain");
    const { calcomLink } = await import("@/adapters/booking/calcom");
    const { getStore } = await import("@/store");
    const port = Number(process.env.PORT ?? 8787);
    const server = createVaaniServer({
      core: { brain: await createBrain(), bookingLink: calcomLink },
      store: await getStore(),
      token: process.env.VAANI_BYOL_TOKEN?.trim() || undefined,
    });
    server.listen(port, () =>
      console.log(`Vaani call server on :${port} — brain: ${process.env.GEMINI_API_KEY ? "gemini" : "rules"}, store: ${process.env.SUPABASE_URL ? "supabase" : "memory"}, auth: ${process.env.VAANI_BYOL_TOKEN ? "bearer token" : "OFF (dev only)"}`),
    );
  })();
}
