// Slack Events API → this Worker → a Durable Object → an outbound WebSocket held
// by the local relay (`bun run relay`), so the Mac needs no inbound port.
//
//   POST /slack/events   Slack's Request URL: signature-checked, url_verification
//                        answered, every message event becomes a tiny "wake".
//   GET  /stream         WebSocket for the relay. The first frame must be
//                        {"auth": RELAY_KEY}; unauthenticated sockets are closed.
//
// Secrets (wrangler secret put): SLACK_SIGNING_SECRET, RELAY_KEY.
import { DurableObject } from "cloudflare:workers";
import { verifySlackSignature, wakeFromEvent } from "./verify.ts";

type Env = { SLACK_SIGNING_SECRET: string; RELAY_KEY: string; HUB: DurableObjectNamespace<Hub> };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const hub = env.HUB.get(env.HUB.idFromName("default"));
    if (url.pathname === "/slack/events" && req.method === "POST") {
      const body = await req.text();
      const ok = await verifySlackSignature(env.SLACK_SIGNING_SECRET, req.headers.get("x-slack-request-timestamp"), req.headers.get("x-slack-signature"), body);
      if (!ok) return new Response("bad signature", { status: 401 });
      let payload: { type?: string; challenge?: string };
      try { payload = JSON.parse(body); } catch { return new Response("bad json", { status: 400 }); }
      if (payload.type === "url_verification") return new Response(payload.challenge ?? "", { headers: { "content-type": "text/plain" } });
      const wake = wakeFromEvent(payload);
      if (wake) ctx.waitUntil(hub.push(wake)); // answer Slack within its 3 s budget
      return new Response("", { status: 200 });
    }
    if (url.pathname === "/stream") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      return hub.fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};

export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer keepalive pings without waking the object from hibernation.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(_req: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["pending"]);
    pair[1].serializeAttachment({ authed: false, at: Date.now() });
    await this.ctx.storage.setAlarm(Date.now() + 5_000); // drop sockets that never authenticate
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as { authed: boolean };
    if (a.authed) return;
    let key = "";
    try { key = (JSON.parse(String(msg)) as { auth?: string }).auth ?? ""; } catch { /* not json */ }
    if (!this.env.RELAY_KEY || key !== this.env.RELAY_KEY) { ws.close(4001, "unauthorized"); return; }
    ws.serializeAttachment({ authed: true, at: Date.now() });
    ws.send(JSON.stringify({ type: "hello" }));
  }

  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { authed: boolean; at: number };
      if (!a.authed && Date.now() - a.at >= 5_000) ws.close(4001, "auth timeout");
    }
  }

  async push(wake: { channel: string; ts: string; thread_ts?: string }): Promise<void> {
    const frame = JSON.stringify({ type: "wake", ...wake });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { authed: boolean };
      if (a.authed) { try { ws.send(frame); } catch { /* closing */ } }
    }
  }
}
