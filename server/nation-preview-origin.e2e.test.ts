// The web app on a Vercel preview talks to the NATION backend through a
// rewrite (/swarm/api/* -> backend). The backend then sees its own Host and
// the preview's Origin. A loopback proxy reproduces exactly that; every
// other service is an owned loopback stand-in. Proves: with the preview
// pattern configured, a signed-in member's cookie works for chat, streaming,
// the live event stream, web_search/web_read, connected-app requests and
// computer routes; admin routes stay admin-only; forged or look-alike
// origins (other vercel.app projects, other teams) are still refused.
import { createHash, randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const MEMBER = "preview@example.test";
const PREVIEW = "https://nation-team-chat-kwwauk9nb-aurk1.vercel.app";
const CROSS = "forbidden: cross-origin request";

it("a trusted NATION preview origin works end to end; others stay refused", async () => {
  let origin = "";
  let callSeq = 0;
  const modelTools: string[][] = [];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return json({ status: true });
    if (url.pathname === "/api/auth/sign-in/email-otp") {
      return json({ user: { id: "acct_preview", email: body.email } }, 200, { "set-auth-token": "fixture_" + randomBytes(12).toString("hex") });
    }
    if (url.pathname === "/api/auth/sign-out") return json({ success: true });
    if (url.pathname === "/search-api/web/search") return json({ web: { results: [{ title: "Pier", url: `${origin}/article`, description: "ferry times" }] } });
    if (url.pathname === "/article") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>Pier</title><p>Ferry at 10:15.</p>"); }
    if (url.pathname.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      modelTools.push(tools);
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user");
      const replies = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1).filter((item: any) => item.role === "tool");
      const asked = JSON.stringify(lastUser?.content ?? "");
      const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `p-${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      const delta = /find ferry/.test(asked) && replies.length === 0 && tools.includes("web_search") ? call("web_search", { query: "ferry" })
        : /find ferry/.test(asked) && replies.length === 1 ? call("web_read", { url: `${origin}/article` })
          : { content: `Reply: ${replies.map((item: any) => JSON.parse(item.content).result).join(" | ") || "hello"}` };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    if (url.pathname.startsWith("/api/v3")) return json({ items: [] });
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin, undefined, {
      providerApi: origin, memberEmails: [MEMBER], webTools: true,
      trustedOrigins: { exact: "https://thenation.city", patterns: "https://nation-team-chat-*-aurk1.vercel.app" },
    });
  // The Vercel rewrite: the browser's Origin and cookie pass through, Host
  // becomes the backend's, and the edge adds forwarding headers.
  const backend = new URL(fixture.info.url);
  const edge = createServer((req, res) => {
    const upstream = httpRequest({
      host: backend.hostname, port: backend.port, method: req.method, path: req.url,
      headers: { ...req.headers, host: "server.aurk.org", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9", "x-forwarded-host": "nation-team-chat-kwwauk9nb-aurk1.vercel.app" },
    }, (reply) => { res.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(res); });
    upstream.on("error", () => { res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
  const edgeUrl = "http://127.0.0.1:" + (edge.address() as { port: number }).port;
  const viaEdge = async (path: string, init: { method?: string; body?: unknown; cookie?: string; from?: string } = {}) => {
    const response = await fetch(edgeUrl + path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", origin: init.from ?? PREVIEW, ...(init.cookie ? { cookie: init.cookie } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: any = {};
    try { body = JSON.parse(text); } catch { body = { text }; }
    return { status: response.status, body, cookie: response.headers.get("set-cookie") };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status, path).toBeLessThan(300);
    return response.json() as Promise<any>;
  };
  try {
    // sign in from the preview; the session cookie comes back through the edge
    expect((await viaEdge("/api/auth/email/start", { method: "POST", body: { email: MEMBER } })).status).toBe(200);
    const verified = await viaEdge("/api/auth/email/verify", { method: "POST", body: { email: MEMBER, code: "12345678", label: MEMBER } });
    expect(verified.status).toBe(200);
    expect(verified.cookie).toMatch(/HttpOnly/);
    expect(verified.cookie).toMatch(/Secure/);
    const member = String(verified.cookie).split(";")[0];
    await viaEdge("/api/credits/status", { cookie: member });
    await owner("/api/admin/credits/adjust", "POST", { userId: "email:" + createHash("sha256").update(MEMBER).digest("hex"), amountUsd: 5, reason: "fixture credit" });

    const { bot } = await owner("/api/bots", "POST", { name: "Preview helper" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "off", composio: false, autoApprove: false });
    const created = await viaEdge(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title: "Preview" }, cookie: member });
    expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
    const thread = created.body.task.threadId as string;

    // live event stream opens with the cookie from the preview origin
    const stream = await fetch(edgeUrl + "/api/events", { headers: { origin: PREVIEW, cookie: member, accept: "text/event-stream" } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toMatch(/event-stream/);
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();

    // normal chat + streamed reply, then web_search and web_read
    const settle = async () => {
      for (let i = 0; i < 5; i++) {
        const state = await runControlOmb(["wait", "--bot", bot.id, "--task", thread, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
        if (state.status !== "needs-user") return state;
        const messages = (await viaEdge(`/api/threads/${thread}/messages`, { cookie: member })).body.messages as any[];
        const open = messages.find((item) => item.card?.requestId && !item.card.answered)?.card;
        if (!open) return state;
        expect((await viaEdge(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: thread, requestId: open.requestId, behavior: "allow" }, cookie: member })).status).toBeLessThan(300);
      }
    };
    const sent = await viaEdge(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Say hello", threadId: thread }, cookie: member });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const first = await settle();
    expect(first.status, JSON.stringify((await viaEdge(`/api/threads/${thread}/messages`, { cookie: member })).body.messages?.slice(-3))).toBe("settled");
    await viaEdge(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "find ferry times", threadId: thread }, cookie: member });
    expect((await settle()).status).toBe("settled");
    const messages = (await viaEdge(`/api/threads/${thread}/messages`, { cookie: member })).body.messages as any[];
    const replies = messages.filter((item) => item.role === "bot" && item.kind === "text").map((item) => item.text);
    expect(replies[0]).toMatch(/hello/);
    expect(replies.at(-1)).toContain("Ferry at 10:15.");
    expect(modelTools.some((tools) => tools.includes("web_search") && tools.includes("web_read"))).toBe(true);

    // connected apps: the member's requests pass the origin gate (the
    // provider outcome is the connector backend's business, not the gate's)
    for (const [path, method] of [["/api/connectors/catalog", "GET"], ["/api/connectors?services=gmail", "GET"], ["/api/connectors/gmail/authorize", "POST"]] as const) {
      const reply = await viaEdge(path, { method, body: method === "POST" ? {} : undefined, cookie: member });
      expect(reply.body.error ?? "", path).not.toBe(CROSS);
      expect(reply.status, `${path} ${JSON.stringify(reply.body)}`).not.toBe(403);
    }
    // computer and admin routes: refused by scope, never by origin
    for (const path of [`/api/bots/${bot.id}/computer`, "/api/admin/controls", "/api/admin/credits"]) {
      const reply = await viaEdge(path, { cookie: member });
      expect(reply.status, path).toBe(403);
      expect(reply.body.error, path).toMatch(/admin scope/);
    }

    // production origin also accepted; everything else refused
    expect((await viaEdge(`/api/threads/${thread}/messages`, { cookie: member, from: "https://thenation.city" })).status).toBe(200);
    for (const forged of ["https://evil.vercel.app", "https://nation-team-chat-kwwauk9nb-evil.vercel.app", "https://evil-nation-team-chat-kwwauk9nb-aurk1.vercel.app",
      "http://nation-team-chat-kwwauk9nb-aurk1.vercel.app", "https://thenation.city.evil.example", "https://attacker.example", "null"]) {
      const reply = await viaEdge(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "forged", threadId: thread }, cookie: member, from: forged });
      expect(reply.status, forged).toBe(403);
      expect(reply.body.error, forged).toBe(CROSS);
    }
    expect(((await viaEdge(`/api/threads/${thread}/messages`, { cookie: member })).body.messages as any[]).some((item) => item.text === "forged")).toBe(false);
  } finally {
    await fixture.close();
    edge.closeAllConnections();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => edge.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
