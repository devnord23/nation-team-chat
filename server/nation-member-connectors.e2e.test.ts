// Hosted NATION, two signed-in members, one shared bot. Everything external
// is an owned loopback stand-in: the NATION account service (emailed-code
// sign-in), the backend connected-apps project (per-account Sessions, OAuth
// links, per-Session MCP) and the NATION API model. Proves, end to end:
//   - a member sees Connect (not "not configured") on a healthy backend,
//   - OAuth pending -> connected for that member only,
//   - each member's inventory, tools and tool results are their own,
//   - approval blocks the connector call until the member allows it,
//   - the connector result reaches the model and the bot's answer,
//   - the bot's Connected apps switch removes the tools,
//   - billing stays on NATION API and each member is debited,
//   - no backend credential reaches members, the model, or the server log.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const PROJECT_KEY = "ak_hosted_fixture_only";
const MODEL_KEY = "nation_fixture_key_only";

type Account = { id: string; toolkit: string; status: string };
const TOOLS: Record<string, { name: string; result: (user: string) => string }> = {
  gmail: { name: "GMAIL_FETCH_EMAILS", result: () => "Inbox: 'Alice fixture invoice' from billing@example.test; 'Team lunch' from pat@example.test" },
  github: { name: "GITHUB_LIST_ISSUES", result: () => "Open issues: #7 'Bob fixture bug'" },
  notion: { name: "NOTION_SEARCH", result: () => "Notion: 'Roadmap' page" },
};

it("hosted members connect and use only their own apps through NATION API", async () => {
  // ── provider state ─────────────────────────────────────────────────
  const accounts = new Map<string, Account[]>(); // composio user id -> accounts
  const sessions = new Map<string, string>(); // session id -> composio user id
  const mcpCalls: Array<{ user: string; tool: string }> = [];
  const modelRequests: Array<{ auth: string; tools: string[]; body: any }> = [];
  let origin = "";
  let accountSeq = 0;
  let callSeq = 0;
  const accountsOf = (user: string) => accounts.get(user) ?? accounts.set(user, []).get(user)!;

  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const path = url.pathname;
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    // NATION account service (emailed code)
    if (path === "/api/auth/email-otp/send-verification-otp") return json({ status: true });
    if (path === "/api/auth/sign-in/email-otp") {
      if (body.otp !== "12345678") return json({ error: "invalid_otp" }, 401);
      return json({ user: { id: "acct_" + body.email.split("@")[0], email: body.email } }, 200, { "set-auth-token": "fixture_" + randomBytes(12).toString("hex") });
    }
    if (path === "/api/auth/sign-out") return json({ success: true });
    // simulated OAuth consent page: visiting it completes the connection
    let m = path.match(/^\/oauth\/([\w-]+)\/(ca_\d+)$/);
    if (m) {
      const account = accountsOf(m[1]).find((item) => item.id === m![2]);
      if (account) account.status = "ACTIVE";
      return json({ ok: Boolean(account) });
    }
    // NATION API model
    if (path.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      modelRequests.push({ auth: String(req.headers.authorization), tools, body });
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      const afterUser = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1);
      const toolReply = afterUser.find((item: any) => item.role === "tool");
      const wanted = /emails/i.test(text) ? "composio_gmail_fetch_emails" : /github issues/i.test(text) ? "composio_github_list_issues" : "";
      const delta = wanted && tools.includes(wanted) && !toolReply
        ? { tool_calls: [{ index: 0, id: `call-${++callSeq}`, type: "function", function: { name: wanted, arguments: "{}" } }] }
        : { content: toolReply ? `From your connected app: ${JSON.parse(toolReply.content).result}` : "I don't have a connected app for that." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10, cost: 0.01 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    // Backend connected-apps project
    if (path.startsWith("/api/v3")) {
      if (req.headers["x-api-key"] !== PROJECT_KEY) return json({ error: "bad key" }, 401);
      if (path === "/api/v3/toolkits") return json({ items: ["gmail", "github", "notion"].map((slug) => ({ slug, name: slug[0].toUpperCase() + slug.slice(1), meta: { description: `${slug} fixture` } })) });
      if (path === "/api/v3.1/auth_configs") return json({ items: [] });
      if (path === "/api/v3.1/tool_router/session" && req.method === "POST") {
        const id = `trs_${sessions.size + 1}`;
        sessions.set(id, body.user_id);
        return json({ session_id: id, mcp: { type: "http", url: `${origin}/mcp/${id}` }, config: { user_id: body.user_id, multi_account: { enable: true } } });
      }
      m = path.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)$/);
      if (m) {
        const user = sessions.get(m[1]);
        return user ? json({ session_id: m[1], mcp: { type: "http", url: `${origin}/mcp/${m[1]}` }, config: { user_id: user, multi_account: { enable: true } } }) : json({}, 404);
      }
      m = path.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)\/toolkits$/);
      if (m) return json({ items: accountsOf(sessions.get(m[1])!).filter((a) => a.status === "ACTIVE").map((a) => ({ slug: a.toolkit, connected_account: { id: a.id, status: a.status } })) });
      m = path.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)\/link$/);
      if (m) {
        const user = sessions.get(m[1])!;
        const account = { id: `ca_${++accountSeq}`, toolkit: body.toolkit, status: "INITIATED" };
        accountsOf(user).push(account);
        return json({ redirect_url: `${origin}/oauth/${user}/${account.id}` });
      }
      if (path === "/api/v3.1/connected_accounts") {
        return json({ items: accountsOf(url.searchParams.get("user_ids")!).map((a) => ({ id: a.id, status: a.status, toolkit: { slug: a.toolkit } })) });
      }
      m = path.match(/^\/api\/v3\.1\/connected_accounts\/(ca_\d+)$/);
      if (m && req.method === "DELETE") {
        for (const list of accounts.values()) { const i = list.findIndex((a) => a.id === m![1]); if (i >= 0) list.splice(i, 1); }
        return json({});
      }
    }
    m = path.match(/^\/mcp\/([\w-]+)$/);
    if (m) {
      if (req.headers["x-api-key"] !== PROJECT_KEY) return json({ error: "bad key" }, 401);
      const user = sessions.get(m[1])!;
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      const active = accountsOf(user).filter((a) => a.status === "ACTIVE").map((a) => TOOLS[a.toolkit]).filter(Boolean);
      let result: unknown = {};
      if (body.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      if (body.method === "tools/list") result = { tools: active.map((tool) => ({ name: tool.name, description: `${tool.name} fixture`, inputSchema: { type: "object", properties: {}, additionalProperties: false } })) };
      if (body.method === "tools/call") {
        const tool = active.find((item) => item.name === body.params.name);
        mcpCalls.push({ user, tool: body.params.name });
        result = tool ? { content: [{ type: "text", text: tool.result(user) }] } : { isError: true, content: [{ type: "text", text: "not connected" }] };
      }
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin, undefined, { providerApi: origin, memberEmails: [ALICE, BOB] });
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
  const signIn = async (email: string) => {
    expect((await request("/api/auth/email/start", { method: "POST", body: { email } })).status).toBe(200);
    const verified = await request("/api/auth/email/verify", { method: "POST", body: { email, code: "12345678", label: email } });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    return String(verified.headers.get("set-cookie")).split(";")[0];
  };
  const wait = (botId: string, threadId: string) =>
    runControlOmb(["wait", "--bot", botId, "--task", threadId, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
  const messages = async (threadId: string, cookie: string) => (await request(`/api/threads/${threadId}/messages`, { cookie })).body.messages as any[];

  try {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    const accountId = (email: string) => "email:" + createHash("sha256").update(email).digest("hex");
    for (const [cookie, email] of [[alice, ALICE], [bob, BOB]]) {
      expect((await request("/api/credits/status", { cookie })).status).toBe(200); // creates the ledger account
      await owner("/api/admin/credits/adjust", "POST", { userId: accountId(email), amountUsd: 5, reason: "fixture credit" });
    }

    // A. backend configured + B. catalog loads, for a member
    const catalog = await request("/api/connectors/catalog", { cookie: alice });
    expect(catalog.status).toBe(200);
    expect(catalog.body.configured).toBe(true);
    expect(catalog.body.cards.map((card: any) => card.slug)).toEqual(expect.arrayContaining(["gmail", "github", "notion"]));
    const memberConfig = await request("/api/config", { cookie: alice });
    expect(memberConfig.body.isProductOwner).toBe(false);
    expect(memberConfig.body.composio).toEqual({ configured: true });
    // a healthy backend with nothing connected is "not connected", never "not configured"
    const empty = await request("/api/connectors/connected", { cookie: alice });
    expect(empty.body).toEqual({ configured: true, credentialStore: "ok", services: {} });

    // C. OAuth path: pending until the member finishes consent, then connected
    const connect = async (cookie: string, slug: string) => {
      const link = await request(`/api/connectors/${slug}/authorize`, { method: "POST", body: {}, cookie });
      expect(link.status, JSON.stringify(link.body)).toBe(200);
      expect(link.body.url).toMatch(new RegExp(`^${origin}/oauth/nation_[0-9a-f]{40}/ca_\\d+$`));
      const pending = (await request(`/api/connectors?services=${slug}`, { cookie })).body.services[slug];
      expect(pending).toMatchObject({ connected: false, pending: true });
      await fetch(link.body.url); // the member's browser completes consent
      const done = (await request(`/api/connectors?services=${slug}`, { cookie })).body.services[slug];
      expect(done).toMatchObject({ connected: true, pending: false, status: "ACTIVE" });
      return done.accounts[0].id as string;
    };
    const aliceGmail = await connect(alice, "gmail");
    await connect(bob, "github");
    const aliceNotion = await connect(alice, "notion");

    // D. inventory is account-scoped
    const aliceInventory = (await request("/api/connectors/connected", { cookie: alice })).body.services;
    const bobInventory = (await request("/api/connectors/connected", { cookie: bob })).body.services;
    expect(Object.keys(aliceInventory).sort()).toEqual(["gmail", "notion"]);
    expect(Object.keys(bobInventory)).toEqual(["github"]);
    // the operator's own install identity sees neither member's accounts
    expect(Object.keys((await owner("/api/connectors/connected")).services)).toEqual([]);
    // Bob cannot disconnect Alice's account by id
    expect((await request(`/api/connectors/gmail/accounts/${aliceGmail}`, { method: "DELETE", cookie: bob })).body).toEqual({ removed: 0 });
    expect(Object.keys((await request("/api/connectors/connected", { cookie: alice })).body.services)).toContain("gmail");
    // disconnect works for the owner of the account
    expect((await request(`/api/connectors/notion/accounts/${aliceNotion}`, { method: "DELETE", cookie: alice })).body).toEqual({ removed: 1 });
    expect(Object.keys((await request("/api/connectors/connected", { cookie: alice })).body.services)).toEqual(["gmail"]);

    // One shared bot; each member talks to it in their own thread.
    const { bot } = await owner("/api/bots", "POST", { name: "Inbox helper" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "off", composio: true, autoApprove: false });
    const thread = async (cookie: string, title: string) => {
      const created = await request(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title }, cookie });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      return created.body.task.threadId as string;
    };
    const aliceThread = await thread(alice, "Alice mail");
    const bobThread = await thread(bob, "Bob code");
    const balance = async (cookie: string) => (await request("/api/credits/status", { cookie })).body.balanceUsd as number;
    const aliceBefore = await balance(alice);

    // E + G + H: Alice asks, the Gmail tool mounts, approval blocks, result reaches the model
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Check my latest emails", threadId: aliceThread }, cookie: alice });
    const pending = await wait(bot.id, aliceThread);
    expect(pending.status, JSON.stringify(pending)).toBe("needs-user");
    expect(mcpCalls).toEqual([]); // G: nothing executed before approval
    const aliceTurn = modelRequests.at(-1)!;
    expect(aliceTurn.tools).toContain("composio_gmail_fetch_emails"); // E
    expect(aliceTurn.tools.some((name) => name.includes("github"))).toBe(false); // not Bob's
    const card = (await messages(aliceThread, alice)).find((item) => item.card?.requestId && !item.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    // Bob posts into Alice's busy thread. His message waits in the queue and
    // is dispatched when her turn settles; it must run as Bob (his apps, his
    // credit), not as whoever ran the turn that happened to settle.
    const bobQueuedBalance = await balance(bob);
    const queued = await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Check my latest emails as well", threadId: aliceThread }, cookie: bob });
    expect(queued.body.queued, JSON.stringify(queued.body)).toBe(true);
    await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: aliceThread, requestId: card.requestId, behavior: "allow" }, cookie: alice });
    expect((await wait(bot.id, aliceThread)).status).toBe("settled");
    for (let i = 0; i < 50 && !modelRequests.some((item) => JSON.stringify(item.body.messages.at(-1)).includes("as well")); i++) await new Promise((r) => setTimeout(r, 100));
    expect((await wait(bot.id, aliceThread)).status).toBe("settled");
    const drainedTurn = modelRequests.find((item) => JSON.stringify(item.body.messages.at(-1)).includes("as well"));
    expect(drainedTurn, "Bob's queued message was dispatched").toBeTruthy();
    expect(drainedTurn!.tools.some((name) => name.includes("gmail"))).toBe(false);
    expect(await balance(bob)).toBeLessThan(bobQueuedBalance);
    expect(mcpCalls).toEqual([{ user: expect.stringMatching(/^nation_[0-9a-f]{40}$/), tool: "GMAIL_FETCH_EMAILS" }]);
    const aliceUser = mcpCalls[0].user;
    // H: the connector result is handed back to the model as the tool reply
    expect(modelRequests.some((request) => request.body.messages.some((item: any) =>
      item.role === "tool" && item.tool_call_id === "call-1" && item.content.includes("Alice fixture invoice")))).toBe(true);
    const aliceReplies = (await messages(aliceThread, alice)).filter((item) => item.role === "bot" && item.kind === "text");
    expect(aliceReplies.some((item) => item.text.includes("Alice fixture invoice"))).toBe(true);
    // Bob's queued turn answered without Alice's mailbox
    expect(aliceReplies.at(-1)?.text).toBe("I don't have a connected app for that.");
    // visible receipt of the connector tool in the transcript
    expect((await messages(aliceThread, alice)).some((item) => item.kind === "activity" && /gmail/i.test(JSON.stringify(item.tool ?? {})))).toBe(true);
    // M: billed through NATION API, to Alice
    expect(new Set(modelRequests.map((item) => item.auth))).toEqual(new Set([`Bearer ${MODEL_KEY}`]));
    expect(await balance(alice)).toBeLessThan(aliceBefore);

    // Same bot, Bob's turn: only Bob's GitHub, executed as Bob
    const bobBefore = await balance(bob);
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "List my GitHub issues", threadId: bobThread }, cookie: bob });
    expect((await wait(bot.id, bobThread)).status).toBe("needs-user");
    const bobTurn = modelRequests.at(-1)!;
    expect(bobTurn.tools).toContain("composio_github_list_issues");
    expect(bobTurn.tools.some((name) => name.includes("gmail"))).toBe(false);
    const bobCard = (await messages(bobThread, bob)).find((item) => item.card?.requestId && !item.card.answered)?.card;
    await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: bobThread, requestId: bobCard.requestId, behavior: "allow" }, cookie: bob });
    expect((await wait(bot.id, bobThread)).status).toBe("settled");
    expect(mcpCalls.at(-1)).toEqual({ user: expect.not.stringMatching(aliceUser), tool: "GITHUB_LIST_ISSUES" });
    expect((await messages(bobThread, bob)).filter((item) => item.role === "bot" && item.kind === "text").at(-1)?.text).toContain("Bob fixture bug");
    expect(await balance(bob)).toBeLessThan(bobBefore);

    // Bob asking for "his" email gets no Gmail tool: he never connected one.
    const callsBefore = mcpCalls.length;
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Check my latest emails", threadId: bobThread }, cookie: bob });
    expect((await wait(bot.id, bobThread)).status).toBe("settled");
    expect(modelRequests.at(-1)!.tools.some((name) => name.includes("gmail"))).toBe(false);
    expect(mcpCalls.length).toBe(callsBefore);

    // F. bot access OFF: no connector tools mount, nothing executes
    await owner(`/api/bots/${bot.id}`, "PATCH", { composio: false });
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Check my latest emails", threadId: aliceThread }, cookie: alice });
    expect((await wait(bot.id, aliceThread)).status).toBe("settled");
    const offTurn = modelRequests.at(-1)!;
    expect(offTurn.tools.some((name) => name.startsWith("composio_"))).toBe(false);
    expect(mcpCalls.length).toBe(callsBefore);
    const offReply = (await messages(aliceThread, alice)).filter((item) => item.role === "bot" && item.kind === "text").at(-1)?.text;
    expect(offReply).not.toContain("Alice fixture invoice");

    // Members cannot flip a bot's grant themselves.
    expect((await request(`/api/bots/${bot.id}`, { method: "PATCH", body: { composio: true }, cookie: bob })).status).toBe(403);

    // N. no infrastructure credential reaches members, the model, or the log
    const log = readFileSync(fixture.info.logPath, "utf8");
    for (const secret of [PROJECT_KEY, MODEL_KEY]) {
      expect(memberResponses.join("\n")).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
    expect(JSON.stringify(modelRequests.map((item) => item.body))).not.toContain(PROJECT_KEY);
    expect(memberResponses.join("\n")).not.toMatch(/composio\.dev|ak_[a-z]/i);
    writeFileSync(`${fixture.info.logPath}.members.json`, JSON.stringify({ mcpCalls, modelTools: modelRequests.map((item) => item.tools) }, null, 2));
    console.log(`NATION member connector evidence: ${fixture.info.logPath}.members.json`);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
