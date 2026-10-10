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
    if (req.url !== "/health") console.log(`[vaani] http ${req.method} ${req.url} ua=${(req.headers["user-agent"] ?? "-").slice(0, 40)}`);
    if (req.url === "/health") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    res.writeHead(404).end();
  });

  server.on("upgrade", (req, socket, head) => {
    console.log(`[vaani] upgrade ${req.url} auth=${req.headers.authorization ? "bearer" : "none"} ua=${(req.headers["user-agent"] ?? "-").slice(0, 40)}`);
    // Vaani appends /<call_id>; its "Test Connection" may hit the bare /vaani URL.
    const m = (req.url ?? "").split("?")[0].match(/^\/vaani(?:\/([^/]+))?\/?$/);
    if (!m) return socket.destroy();
    // Vaani's dashboard "Test Connection" runs in the browser, which can't send an
    // Authorization header, and it uses the bare /vaani URL. Let it see the handshake,
    // then close. It can't drive the agent: frames on a probe are ignored.
    if (!m[1] && !tokenOk(req, opts.token)) {
      return wss.handleUpgrade(req, socket, head, (ws) => {
        handshakeFrames().forEach((f) => ws.send(JSON.stringify(f)));
        console.log("[vaani] connection test (no call id): handshake sent, closing");
        setTimeout(() => ws.close(), 3000);
      });
    }
    if (!tokenOk(req, opts.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onCall(ws, m[1] ? decodeURIComponent(m[1]) : `probe-${Date.now()}`));
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
        console.log(`[vaani] call ${callId} closed → ${r ? r.outcome.kind : "no caller turns (connection test or silent call; webhook will log it)"}`);
      } catch (err) {
        console.error(`[vaani] ${callId} finalize failed:`, (err as Error).message);
      } finally {
        opts.onCallFinished?.(callId);
      }
    });
  }

  return server;
}
