// Hosted NATION: a signed-in member's NATION API turn searches the web and
// reads a page with NATION-managed tools. Every external service is an
// owned loopback stand-in (account service, search provider, a public page,
// the NATION API model). Proves: the tools mount with no member setup, the
// model calls them and gets the results back in the normal loop, each use
// is metered to the member's credit, a provider failure reaches the model
// as a NATION message, the provider and its key never reach the member, the
// model or the log, and the admin can switch the tools off.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const MEMBER = "reader@example.test";
const SEARCH_KEY = "search_fixture_key_only";

it("NATION API agents search and read the web on NATION's account", async () => {
  const modelRequests: Array<{ tools: string[]; body: any }> = [];
  const searchCalls: Array<{ query: string; key: string }> = [];
  let origin = "";
  let callSeq = 0;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return json({ status: true });
    if (url.pathname === "/api/auth/sign-in/email-otp") {
      return json({ user: { id: "acct_reader", email: body.email } }, 200, { "set-auth-token": "fixture_" + randomBytes(12).toString("hex") });
    }
    if (url.pathname === "/api/auth/sign-out") return json({ success: true });
    // stand-in search provider (the backend's, never shown to members)
    if (url.pathname === "/search-api/web/search") {
      const query = url.searchParams.get("q") ?? "";
      searchCalls.push({ query, key: String(req.headers["x-subscription-token"]) });
      if (req.headers["x-subscription-token"] !== SEARCH_KEY) return json({ error: "bad key" }, 401);
      if (/outage/.test(query)) return json({ message: "provider exploded; token search_fixture_key_only rejected" }, 500);
      return json({ web: { results: [
        { title: "Harbor opening hours", url: `${origin}/article`, description: "The harbor museum opens at 9." },
      ] } });
    }
    // a public page the reader fetches
    if (url.pathname === "/article") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><head><title>Harbor museum</title><script>track()</script></head><body><h1>Visiting</h1><p>Open daily 09:00-17:00. Ferry pier 3.</p></body></html>");
    }
    if (url.pathname.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      modelRequests.push({ tools, body });
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user" && typeof item.content === "string");
      const ask = String(lastUser?.content ?? "").trim().split("\n").at(-1) ?? "";
      const replies = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1).filter((item: any) => item.role === "tool");
      let delta: Record<string, unknown>;
      const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `w-${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      if (/^find /i.test(ask) && tools.includes("web_search") && replies.length === 0) {
        delta = call("web_search", { query: ask.replace(/^find /i, "") });
      } else if (/^find /i.test(ask) && replies.length === 1 && !/outage/.test(ask)) {
        const found = JSON.parse(JSON.parse(replies[0].content).result);
        delta = call("web_read", { url: found.results[0].url });
      } else {
        delta = { content: `Answer from tools: ${replies.map((item: any) => JSON.parse(item.content).result).join(" | ") || "none"}` };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    if (url.pathname.startsWith("/api/v3")) return json({ items: [] });
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin, undefined, { providerApi: origin, memberEmails: [MEMBER], webTools: true });
  const memberResponses: string[] = [];
  const request = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    if (init.cookie) memberResponses.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const r = await request(path, { method, body });
    expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  try {
    expect((await request("/api/auth/email/start", { method: "POST", body: { email: MEMBER } })).status).toBe(200);
    const verified = await request("/api/auth/email/verify", { method: "POST", body: { email: MEMBER, code: "12345678", label: MEMBER } });
    const member = String(verified.headers.get("set-cookie")).split(";")[0];
    const accountId = "email:" + createHash("sha256").update(MEMBER).digest("hex");
    expect((await request("/api/credits/status", { cookie: member })).status).toBe(200);
    await owner("/api/admin/credits/adjust", "POST", { userId: accountId, amountUsd: 5, reason: "fixture credit" });

    // The admin sees the backing and prices; the member sees none of it.
    const adminStatus = await owner("/api/admin/web-tools");
    expect(adminStatus).toMatchObject({ enabled: true, search: { configured: true, provider: "brave", source: "environment" }, reader: { configured: true } });
    expect(JSON.stringify(adminStatus)).not.toContain(SEARCH_KEY);
    expect((await request("/api/admin/web-tools", { cookie: member })).status).toBe(403);
    expect((await request("/api/config", { cookie: member })).body.webTools).toBeUndefined();

    const { bot } = await owner("/api/bots", "POST", { name: "Researcher" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "off", composio: false, autoApprove: false });
    const thread = (await request(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title: "Research" }, cookie: member })).body.task.threadId;
    const settle = async () => {
      for (;;) {
        const state = await runControlOmb(["wait", "--bot", bot.id, "--task", thread, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
        if (state.status !== "needs-user") return state;
        const messages = (await request(`/api/threads/${thread}/messages`, { cookie: member })).body.messages as any[];
        const open = messages.find((item) => item.card?.requestId && !item.card.answered)?.card;
        if (!open) return state;
        await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: thread, requestId: open.requestId, behavior: "allow" }, cookie: member });
      }
    };
    const balance = async () => (await request("/api/credits/status", { cookie: member })).body.balanceUsd as number;
    const before = await balance();

    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "find harbor museum opening hours", threadId: thread }, cookie: member });
    expect((await settle()).status).toBe("settled");
    // mounted with no member setup, alongside (not instead of) other tools
    expect(modelRequests[0].tools).toEqual(expect.arrayContaining(["web_search", "web_read"]));
    expect(JSON.stringify(modelRequests[0].body.messages.filter((item: any) => item.role === "system"))).toContain("web_search");
    // the backend searched with NATION's key; the result and the page came back into the loop
    expect(searchCalls).toEqual([{ query: "harbor museum opening hours", key: SEARCH_KEY }]);
    const toolReplies = modelRequests.at(-1)!.body.messages.filter((item: any) => item.role === "tool").map((item: any) => item.content).join("\n");
    expect(toolReplies).toContain("Harbor opening hours");
    expect(toolReplies).toContain("Open daily 09:00-17:00. Ferry pier 3.");
    expect(toolReplies).not.toContain("track()");
    const answer = ((await request(`/api/threads/${thread}/messages`, { cookie: member })).body.messages as any[]).filter((item) => item.role === "bot" && item.kind === "text").at(-1);
    expect(answer.text).toContain("Ferry pier 3");

    // metered to the member: one search and one read, plus the model calls
    const ledger = (await owner("/api/admin/credits")).ledger as Array<{ user_id: string; reason: string; amount_micros: number }>;
    const mine = ledger.filter((row) => row.user_id === accountId);
    expect(mine.filter((row) => row.reason === "NATION web search")).toHaveLength(1);
    expect(mine.filter((row) => row.reason === "NATION web reader")).toHaveLength(1);
    expect(mine.find((row) => row.reason === "NATION web search")!.amount_micros).toBeLessThan(0);
    expect(await balance()).toBeLessThan(before);

    // a provider failure reaches the model as a NATION message, uncharged
    const searchRowsBefore = mine.filter((row) => row.reason === "NATION web search").length;
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "find outage report", threadId: thread }, cookie: member });
    expect((await settle()).status).toMatch(/settled|failed/);
    const failed = modelRequests.at(-1)!.body.messages.filter((item: any) => item.role === "tool").map((item: any) => item.content).join("\n");
    expect(failed).toMatch(/Web search is temporarily unavailable/);
    expect(failed).not.toMatch(/brave|provider exploded|search_fixture_key_only|api key/i);
    const after = ((await owner("/api/admin/credits")).ledger as any[]).filter((row) => row.user_id === accountId && row.reason === "NATION web search");
    expect(after).toHaveLength(searchRowsBefore);

    // no provider identity or key anywhere a member, the model or the log can see
    expect(memberResponses.join("\n")).not.toMatch(/brave|search_fixture_key_only|x-subscription/i);
    expect(JSON.stringify(modelRequests.map((item) => item.body))).not.toContain(SEARCH_KEY);
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain(SEARCH_KEY);

    // the admin can switch web tools off for every agent
    await owner("/api/config", "PATCH", { features: { webTools: false } });
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Say hello", threadId: thread }, cookie: member });
    expect((await settle()).status).toBe("settled");
    expect(modelRequests.at(-1)!.tools.some((name) => name.startsWith("web_"))).toBe(false);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
