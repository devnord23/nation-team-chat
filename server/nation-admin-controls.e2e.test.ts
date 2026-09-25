// Hosted NATION /admin agent controls. The account service, search provider,
// NATION API model and cloud computer provider are owned loopback stand-ins.
// Proves: one admin view shows models, routing, per-tool switches, backing
// and health without any credential; members (with or without forged
// owner/admin headers) get 403 on it and on every write; the admin's model
// routing and per-tool switches take effect on the next member turn; a
// Claude/Anthropic or malformed model id is refused.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const MEMBER = "controls@example.test";
const SEARCH_KEY = "search_fixture_key_only";

it("the admin controls models and agent tools; members cannot", async () => {
  const modelRequests: Array<{ model: string; tools: string[] }> = [];
  const boxCalls: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return json({ status: true });
    if (url.pathname === "/api/auth/sign-in/email-otp") {
      return json({ user: { id: "acct_controls", email: body.email } }, 200, { "set-auth-token": "fixture_" + randomBytes(12).toString("hex") });
    }
    if (url.pathname === "/api/auth/sign-out") return json({ success: true });
    if (url.pathname === "/search-api/web/search") return json({ web: { results: [] } });
    if (url.pathname.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      modelRequests.push({ model: body.model, tools });
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user");
      const toolReply = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1).find((item: any) => item.role === "tool");
      const wantsKey = /need xai/.test(JSON.stringify(lastUser?.content ?? "")) && tools.includes("agents_request_credential") && !toolReply;
      const delta = wantsKey
        ? { tool_calls: [{ index: 0, id: "cred-1", type: "function", function: { name: "agents_request_credential", arguments: JSON.stringify({ credential_id: "xaiApiKey", reason: "fixture" }) } }] }
        : { content: toolReply ? `Tool said: ${JSON.parse(toolReply.content).result}` : "Hello." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    if (url.pathname.startsWith("/api/v3")) return json({ items: [] });
    if (url.pathname.startsWith("/boxes")) { boxCalls.push(`${req.method} ${url.pathname}`); return json({ ok: true, boxes: [] }); }
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], origin,
    origin, undefined, { providerApi: origin, memberEmails: [MEMBER], webTools: true, modelRoutes: { fast: "fixture/fast-env" } });
  const request = async (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {}, text };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const r = await request(path, { method, body });
    expect(r.status, `${method} ${path} ${r.text}`).toBeLessThan(300);
    return r.body;
  };
  const forged = { "x-openmausbot-desktop-owner": "1", "x-openmausbot-companion": "1", "x-forwarded-for": "127.0.0.1", "x-nation-admin": "1" };
  try {
    expect((await request("/api/auth/email/start", { method: "POST", body: { email: MEMBER } })).status).toBe(200);
    const verified = await fetch(fixture.info.url + "/api/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: MEMBER, code: "12345678", label: MEMBER }) });
    const member = String(verified.headers.get("set-cookie")).split(";")[0];
    await request("/api/credits/status", { cookie: member });
    await owner("/api/admin/credits/adjust", "POST", { userId: "email:" + createHash("sha256").update(MEMBER).digest("hex"), amountUsd: 5, reason: "fixture credit" });

    // One admin view, no secrets.
    const controls = await owner("/api/admin/controls");
    expect(controls.models).toMatchObject({ fast: "fixture/fast-env", enabled: true, sources: { fast: "environment" } });
    expect(controls.tools).toMatchObject({ webSearch: { enabled: true, available: true }, webRead: { enabled: true }, computers: { enabled: true, available: true } });
    expect(controls.health).toMatchObject({ nationApi: { configured: true }, search: { configured: true }, cloudComputer: { configured: true } });
    expect(JSON.stringify(controls)).not.toMatch(new RegExp(`${SEARCH_KEY}|box_verification_fixture|sk-`));

    // Members: 403 on the view and on every write, forged headers or not.
    for (const headers of [undefined, forged]) {
      expect((await request("/api/admin/controls", { cookie: member, headers })).status).toBe(403);
      expect((await request("/api/admin/model-routing", { cookie: member, headers })).status).toBe(403);
      for (const body of [{ modelRouting: { fast: "fixture/mine" } }, { features: { webSearch: false } }, { webSearch: { provider: "brave", apiKey: "stolen" } }]) {
        expect((await request("/api/config", { method: "PATCH", cookie: member, headers, body })).status).toBe(403);
      }
    }

    // Only allowed NATION API model ids.
    expect((await request("/api/config", { method: "PATCH", body: { modelRouting: { strong: "anthropic/claude-sonnet-4" } } })).status).toBe(400);
    expect((await request("/api/config", { method: "PATCH", body: { modelRouting: { fast: "not a model" } } })).status).toBe(400);

    const { bot } = await owner("/api/bots", "POST", { name: "Controlled" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "cloud", cloudBackend: "box", composio: false, autoApprove: false });
    const thread = (await request(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title: "Hello" }, cookie: member })).body.task.threadId;
    const turn = async () => {
      const before = modelRequests.length;
      await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Say hello", threadId: thread }, cookie: member });
      await runControlOmb(["wait", "--bot", bot.id, "--task", thread, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
      return modelRequests.slice(before);
    };

    // The admin's routing wins over the environment for the next turn.
    await owner("/api/config", "PATCH", { modelRouting: { fast: "fixture/fast-admin", defaultModel: "fixture/default-admin" }, features: { webSearch: false, computers: false } });
    const routed = await turn();
    expect(routed[0].model).toBe("fixture/fast-admin");
    expect((await owner("/api/admin/controls")).models.sources).toMatchObject({ fast: "admin", defaultModel: "admin" });
    // Per-tool switches: search off, reader on; computers off for every agent.
    expect(routed[0].tools).toContain("web_read");
    expect(routed[0].tools).not.toContain("web_search");
    expect(routed[0].tools.some((name) => name.startsWith("computer_"))).toBe(false);
    expect(boxCalls).toEqual([]);

    // Routing off: every turn uses the default model.
    await owner("/api/config", "PATCH", { modelRouting: { enabled: false }, features: { webSearch: true, webRead: false } });
    const single = await turn();
    expect(single[0].model).toBe("fixture/default-admin");
    expect(single[0].tools).toContain("web_search");
    expect(single[0].tools).not.toContain("web_read");
    expect((await owner("/api/admin/controls")).models).toMatchObject({ enabled: false, fast: "fixture/default-admin", strong: "fixture/default-admin" });

    // A member is never asked for a provider key: no credential card, and the
    // agent hears the capability isn't set up here.
    const settleAll = async () => {
      for (let i = 0; i < 5; i++) {
        const state = await runControlOmb(["wait", "--bot", bot.id, "--task", thread, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
        if (state.status !== "needs-user") return state;
        const messages = (await request(`/api/threads/${thread}/messages`, { cookie: member })).body.messages as any[];
        const open = messages.find((item) => item.card?.requestId && !item.card.answered)?.card;
        if (!open) return state;
        await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: thread, requestId: open.requestId, behavior: "allow" }, cookie: member });
      }
    };
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "need xai", threadId: thread }, cookie: member });
    await settleAll();
    const transcript = (await request(`/api/threads/${thread}/messages`, { cookie: member })).body.messages as any[];
    expect(transcript.some((item) => item.kind === "secret")).toBe(false);
    expect(transcript.filter((item) => item.role === "bot" && item.kind === "text").at(-1)?.text).toMatch(/isn't set up in this workspace/);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
