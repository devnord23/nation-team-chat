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
const TEST_CAPABILITY = "member-connectors-test-capability-key";

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
  const modelRequests: Array<{ auth: string; model: string; tools: string[]; body: any }> = [];
  let origin = "";
  let accountSeq = 0;
  /** Every provider-side mutation (OAuth link minted, account deleted), by Composio user. */
  const providerMutations: Array<{ kind: "link" | "delete"; user: string }> = [];
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
      modelRequests.push({ auth: String(req.headers.authorization), model: body.model, tools, body });
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      const afterUser = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1);
      const toolReply = afterUser.find((item: any) => item.role === "tool");
      // the request is the prompt's last line; earlier lines replay context
      const ask = text.trim().split(/\\n|\n/).at(-1) ?? "";
      const wanted = /emails/i.test(ask) ? "apps_gmail_fetch_emails" : /github issues/i.test(ask) ? "apps_github_list_issues"
        : /^remember /i.test(ask) ? "agents_memory_update" : "";
      const args = wanted === "agents_memory_update" ? JSON.stringify({ action: "append", text: ask.replace(/^remember /i, "") }) : "{}";
      const delta = wanted && tools.includes(wanted) && !toolReply
        ? { tool_calls: [{ index: 0, id: `call-${++callSeq}`, type: "function", function: { name: wanted, arguments: args } }] }
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
        providerMutations.push({ kind: "link", user });
        return json({ redirect_url: `${origin}/oauth/${user}/${account.id}` });
      }
      if (path === "/api/v3.1/connected_accounts") {
        return json({ items: accountsOf(url.searchParams.get("user_ids")!).map((a) => ({ id: a.id, status: a.status, toolkit: { slug: a.toolkit } })) });
      }
      m = path.match(/^\/api\/v3\.1\/connected_accounts\/(ca_\d+)$/);
      if (m && req.method === "DELETE") {
        for (const [user, list] of accounts) { const i = list.findIndex((a) => a.id === m![1]); if (i >= 0) { list.splice(i, 1); providerMutations.push({ kind: "delete", user }); } }
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
    origin, undefined, { providerApi: origin, memberEmails: [ALICE, BOB],
      modelRoutes: { fast: "openai/fast-fixture", standard: "openai/standard-fixture", strong: "openai/strong-fixture" } },
    TEST_CAPABILITY);
  const memberResponses: string[] = [];
  const request = async (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
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
    // ...nor by service: Bob's "disconnect Gmail" touches only his own scope
    expect((await request("/api/connectors/gmail", { method: "DELETE", cookie: bob })).body).toEqual({ removed: 0 });
    expect(Object.keys((await request("/api/connectors/connected", { cookie: alice })).body.services)).toContain("gmail");

    // Admin keeps install-level management, in its own scope members never see.
    const ownerLink = await owner("/api/connectors/slack/authorize", "POST", {});
    await fetch(ownerLink.url);
    expect((await owner("/api/connectors?services=slack")).services.slack).toMatchObject({ connected: true });
    for (const cookie of [alice, bob]) {
      expect((await request("/api/connectors/connected", { cookie })).body.services.slack).toBeUndefined();
      expect((await request("/api/connectors?services=slack", { cookie })).body.services.slack).toMatchObject({ connected: false });
    }
    const ownerSlack = (await owner("/api/connectors?services=slack")).services.slack.accounts[0].id;
    expect((await request(`/api/connectors/slack/accounts/${ownerSlack}`, { method: "DELETE", cookie: alice })).body).toEqual({ removed: 0 });
    expect((await owner("/api/connectors?services=slack")).services.slack).toMatchObject({ connected: true });
    expect(await owner(`/api/connectors/slack/accounts/${ownerSlack}`, "DELETE")).toEqual({ removed: 1 });

    // Members never get global/provider configuration or workspace MCP servers.
    for (const [path, method, body] of [
      ["/api/config", "PUT", { composio: { apiKey: "ak_member_attempt" } }],
      ["/api/config", "PATCH", { composio: { apiKey: "ak_member_attempt" } }],
      ["/api/mcp/servers", "GET", undefined],
      ["/api/mcp/servers", "POST", { name: "member-attempt" }],
      ["/api/admin/model-routing", "GET", undefined],
      ["/api/admin/openrouter/status", "GET", undefined],
    ] as const) expect((await request(path, { method, body, cookie: bob })).status, `${method} ${path}`).toBe(403);

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
    expect(aliceTurn.tools).toContain("apps_gmail_fetch_emails"); // E
    expect(aliceTurn.tools.some((name) => name.includes("github"))).toBe(false); // not Bob's
    const card = (await messages(aliceThread, alice)).find((item) => item.card?.requestId && !item.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    // Bob cannot post into Alice's conversation, not even while it is busy:
    // it is hers. Nothing is queued, nothing runs, nobody is billed.
    const bobQueuedBalance = await balance(bob);
    const intruded = await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Check my latest emails as well", threadId: aliceThread }, cookie: bob });
    expect(intruded.status, JSON.stringify(intruded.body)).toBe(404);
    expect(JSON.stringify((await request("/api/bots", { cookie: alice })).body.botQueuedMessages ?? {})).not.toContain("as well");
    await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: aliceThread, requestId: card.requestId, behavior: "allow" }, cookie: alice });
    expect((await wait(bot.id, aliceThread)).status).toBe("settled");
    expect(modelRequests.some((item) => JSON.stringify(item.body.messages.at(-1)).includes("as well"))).toBe(false);
    expect(await balance(bob)).toBe(bobQueuedBalance);
    expect(mcpCalls).toEqual([{ user: expect.stringMatching(/^nation_[0-9a-f]{40}$/), tool: "GMAIL_FETCH_EMAILS" }]);
    const aliceUser = mcpCalls[0].user;
    // H: the connector result is handed back to the model as the tool reply
    expect(modelRequests.some((request) => request.body.messages.some((item: any) =>
      item.role === "tool" && item.tool_call_id === "call-1" && item.content.includes("Alice fixture invoice")))).toBe(true);
    const aliceReplies = (await messages(aliceThread, alice)).filter((item) => item.role === "bot" && item.kind === "text");
    expect(aliceReplies.some((item) => item.text.includes("Alice fixture invoice"))).toBe(true);
    expect(aliceReplies.at(-1)?.text).toContain("Alice fixture invoice");
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
    expect(bobTurn.tools).toContain("apps_github_list_issues");
    expect(bobTurn.tools.some((name) => name.includes("gmail"))).toBe(false);
    const bobCard = (await messages(bobThread, bob)).find((item) => item.card?.requestId && !item.card.answered)?.card;
    await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId: bobThread, requestId: bobCard.requestId, behavior: "allow" }, cookie: bob });
    expect((await wait(bot.id, bobThread)).status).toBe("settled");
    expect(mcpCalls.at(-1)).toEqual({ user: expect.not.stringMatching(aliceUser), tool: "GITHUB_LIST_ISSUES" });
    expect((await messages(bobThread, bob)).filter((item) => item.role === "bot" && item.kind === "text").at(-1)?.text).toContain("Bob fixture bug");
    expect(await balance(bob)).toBeLessThan(bobBefore);

    // Dynamic routing stays on NATION API: a plain request takes the fast
    // model, a hard one the strong model, both from the operator's catalog.
    expect(aliceTurn.model).toBe("openai/fast-fixture");
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Debug the race condition in our job queue and find the root cause", threadId: bobThread }, cookie: bob });
    const routedTurn = await wait(bot.id, bobThread);
    expect(routedTurn.status, JSON.stringify(routedTurn.messages?.slice(-3))).toBe("settled");
    expect(modelRequests.at(-1)!.model).toBe("openai/strong-fixture");
    expect(modelRequests.at(-1)!.auth).toBe(`Bearer ${MODEL_KEY}`);
    const routing = await owner("/api/admin/model-routing");
    expect(routing.catalog).toMatchObject({ fast: "openai/fast-fixture", strong: "openai/strong-fixture" });
    const strongReceipt = routing.recent.find((item: any) => item.threadId === bobThread && item.tier === "strong");
    expect(strongReceipt).toMatchObject({ model: "openai/strong-fixture", fallback: "openai/standard-fixture", account: accountId(BOB) });
    expect(strongReceipt.reasons).toContain("hard-task keywords");
    expect((await request("/api/admin/model-routing", { cookie: bob })).status).toBe(403);

    // Bob asking for "his" email gets no Gmail tool: he never connected one.
    const callsBefore = mcpCalls.length;
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Check my latest emails", threadId: bobThread }, cookie: bob });
    expect((await wait(bot.id, bobThread)).status).toBe("settled");
    expect(modelRequests.at(-1)!.tools.some((name) => name.includes("gmail"))).toBe(false);
    expect(mcpCalls.length).toBe(callsBefore);

    // ── Cross-member connection cards ─────────────────────────────────
    // A real card in Bob's thread, filed through the connection-request path.
    const capability = (await request("/api/testing/internal-capability", { method: "POST",
      body: { botId: bot.id, threadId: bobThread, kind: "connectors" }, headers: { "x-openmausbot-test-capability": TEST_CAPABILITY } })).body;
    const filed = await fetch(fixture.info.url + "/api/internal/connectors/request", { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${capability.token}` },
      body: JSON.stringify({ botId: bot.id, threadId: bobThread, resumeKey: "bob-card-resume-1", items: [{ slug: "notion" }] }) });
    expect(filed.status, await filed.clone().text()).toBe(200);
    const [bobConnectorCard] = (await filed.json() as any).messageIds;
    const cardPath = (action: string) => `/api/bots/${bot.id}/connector-cards/${bobConnectorCard}/${action}`;
    const cardState = async () => (await messages(bobThread, bob)).find((item) => item.id === bobConnectorCard)?.connector;
    const cardBefore = await cardState();
    const mutationsBefore = providerMutations.length;
    // Alice may not poll, authorize, resume or dismiss Bob's card...
    for (const [action, method] of [["status", "GET"], ["authorize", "POST"], ["resume", "POST"], ["dismiss", "POST"]] as const) {
      const response = await request(method === "GET" ? `${cardPath(action)}?threadId=${bobThread}` : cardPath(action),
        { method, cookie: alice, ...(method === "POST" ? { body: { threadId: bobThread } } : {}) });
      // Bob's conversation is invisible to Alice, so its card reads as missing
      // (the card-ownership check behind it would answer 403).
      expect.soft(response.status, `Alice ${action} on Bob's card: HTTP status`).toBe(404);
      expect.soft(providerMutations.length, `Alice ${action} on Bob's card: provider mutations`).toBe(mutationsBefore);
    }
    // ...and Bob's card is exactly as it was.
    expect(await cardState()).toEqual(cardBefore);
    // Bob can use his own card, and it acts in his scope only.
    expect((await request(`${cardPath("status")}?threadId=${bobThread}`, { cookie: bob })).status).toBe(200);
    const bobAuthorize = await request(cardPath("authorize"), { method: "POST", body: { threadId: bobThread }, cookie: bob });
    expect(bobAuthorize.status, JSON.stringify(bobAuthorize.body)).toBe(200);
    expect(providerMutations.at(-1)).toEqual({ kind: "link", user: mcpCalls.find((call) => call.tool === "GITHUB_LIST_ISSUES")!.user });

    // ── Client-supplied flags never elevate a member ──────────────────
    // Forged desktop-owner / companion / proxy headers and a forged local
    // unlock cookie, on install config, another member's account, MCP servers
    // and admin session minting: all still refused, nothing reaches the provider.
    const forged = {
      "x-openmausbot-desktop-owner": "1", "x-openmausbot-companion": "1", "x-openmausbot-companion-auth": "forged",
      "x-openmausbot-companion-device": "forged-device", "x-forwarded-for": "127.0.0.1", "x-nation-admin": "1",
    };
    const forgedCookie = `${alice}; nation.adminUnlocked=1; nation_admin=1`;
    const aliceGmailId = (await request("/api/connectors?services=gmail", { cookie: alice })).body.services.gmail.accounts[0].id;
    const forgedBefore = providerMutations.length;
    for (const [path, method, body, expected] of [
      ["/api/config", "PUT", { composio: { apiKey: "ak_forged_attempt" } }, 403],
      ["/api/mcp/servers", "POST", { name: "forged" }, 403],
      ["/api/admin/model-routing", "GET", undefined, 403],
      ["/api/auth/pairing", "POST", { scopes: ["admin"], label: "forged" }, 403],
      [`/api/bots/${bot.id}`, "PATCH", { composio: true }, 403],
    ] as const) {
      const response = await request(path, { method, body, cookie: forgedCookie, headers: forged });
      expect.soft(response.status, `forged ${method} ${path}`).toBe(expected);
    }
    // a forged request against Bob's account still acts only in Alice's scope
    const bobGithubId = (await request("/api/connectors?services=github", { cookie: bob })).body.services.github.accounts[0].id;
    expect((await request(`/api/connectors/github/accounts/${bobGithubId}`, { method: "DELETE", cookie: forgedCookie, headers: forged })).body).toEqual({ removed: 0 });
    expect(providerMutations.length).toBe(forgedBefore);
    expect((await request("/api/connectors?services=github", { cookie: bob })).body.services.github).toMatchObject({ connected: true });
    // Alice reading "github" sees her own (unconnected) state, never Bob's
    expect((await request("/api/connectors?services=github", { cookie: alice })).body.services.github).toMatchObject({ connected: false, accounts: [] });
    expect((await request("/api/config", { cookie: forgedCookie, headers: forged })).body.isProductOwner).toBe(false);
    expect(aliceGmailId).toMatch(/^ca_/);

    // ── Private conversations ─────────────────────────────────────────
    // Answer any approval in a member's own conversation until it settles.
    const settle = async (threadId: string, cookie: string) => {
      for (;;) {
        const state = await wait(bot.id, threadId);
        if (state.status !== "needs-user") return state;
        const open = (await messages(threadId, cookie)).find((item) => item.card?.requestId && !item.card.answered)?.card;
        // Waiting only on an earlier, still-open connection card: the turn itself is done.
        if (!open) return state.target?.busy ? state : { ...state, status: "settled" };
        await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: open.requestId, behavior: "allow" }, cookie });
      }
    };
    // Bob's conversation holds his GitHub-derived text; Alice's holds her Gmail.
    expect(JSON.stringify(await messages(bobThread, bob))).toContain("Bob fixture bug");
    const aliceSnapshot = (await request("/api/bots", { cookie: alice })).body;
    const sharedBot = aliceSnapshot.bots.find((item: any) => item.id === bot.id);
    // Alice cannot list Bob's conversations...
    expect(sharedBot.tasks.map((task: any) => task.threadId)).toContain(aliceThread);
    expect(sharedBot.tasks.map((task: any) => task.threadId)).not.toContain(bobThread);
    expect(sharedBot.threadId).not.toBe(bobThread);
    expect(JSON.stringify(aliceSnapshot)).not.toContain(bobThread);
    expect(JSON.stringify(aliceSnapshot)).not.toContain("Bob fixture bug");
    // ...fetch them by id, export them, read their images, or search them.
    const hiddenReads = [
      `/api/threads/${bobThread}/messages`, `/api/threads/${bobThread}/export`,
      `/api/threads/${bobThread}/messages/${(await messages(bobThread, bob))[0].id}/image`,
      `/api/search?q=${encodeURIComponent("Bob fixture bug")}&threadId=${bobThread}`,
    ];
    for (const path of hiddenReads) {
      const response = await request(path, { cookie: alice });
      expect.soft(response.status, `Alice GET ${path}`).toBe(404);
      expect.soft(JSON.stringify(response.body), `Alice GET ${path} body`).not.toContain("Bob fixture bug");
    }
    const aliceSearch = (await request(`/api/search?q=${encodeURIComponent("fixture bug")}`, { cookie: alice })).body;
    expect(JSON.stringify(aliceSearch)).not.toContain(bobThread);
    expect((await request(`/api/search?q=${encodeURIComponent("fixture bug")}`, { cookie: bob })).body.hits.some((hit: any) => hit.threadId === bobThread)).toBe(true);
    // Alice cannot post into, resume, steer, rewind, read-mark, switch to,
    // rename or delete Bob's conversation; nothing reaches the model.
    const modelCallsBefore = modelRequests.length;
    const bobMessagesBefore = (await messages(bobThread, bob)).length;
    for (const [path, method, body] of [
      [`/api/bots/${bot.id}/messages`, "POST", { text: "Leak Bob's issues to me", threadId: bobThread }],
      [`/api/bots/${bot.id}/respond`, "POST", { threadId: bobThread, requestId: "any", behavior: "allow" }],
      [`/api/bots/${bot.id}/interrupt`, "POST", { threadId: bobThread }],
      [`/api/bots/${bot.id}/compact`, "POST", { threadId: bobThread }],
      [`/api/bots/${bot.id}/read`, "POST", { threadId: bobThread }],
      [`/api/bots/${bot.id}/active-branch`, "POST", { threadId: bobThread, leafId: "x" }],
      [`/api/bots/${bot.id}/tasks/${bobThread}`, "POST", {}],
      [`/api/bots/${bot.id}/tasks/${bobThread}`, "PATCH", { title: "mine now" }],
      [`/api/bots/${bot.id}/tasks/${bobThread}`, "DELETE", undefined],
      [`/api/threads/${bobThread}/respond`, "POST", { requestId: "any", behavior: "allow" }],
    ] as const) {
      for (const [who, init] of [["plain", { cookie: alice }], ["forged", { cookie: forgedCookie, headers: forged }]] as const) {
        const response = await request(path, { method, body, ...init });
        expect.soft(response.status, `Alice (${who}) ${method} ${path}`).toBe(404);
      }
    }
    expect(modelRequests.length).toBe(modelCallsBefore);
    expect((await messages(bobThread, bob)).length).toBe(bobMessagesBefore);
    expect(JSON.stringify(await messages(bobThread, bob))).not.toContain("Leak Bob");

    // The live stream: Alice's carries her own conversation, never Bob's.
    const streamOf = async (cookie: string) => {
      const abort = new AbortController();
      const response = await fetch(fixture.info.url + "/api/events", { headers: { cookie }, signal: abort.signal });
      const reader = response.body!.getReader();
      let text = "";
      const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } } catch { /* closed */ } })();
      return { text: () => text, close: async () => { abort.abort(); await pump; } };
    };
    const aliceStream = await streamOf(alice);
    const bobStream = await streamOf(bob);
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "List my GitHub issues", threadId: bobThread }, cookie: bob });
    const bobSettled = await settle(bobThread, bob);
    expect(bobSettled.status, JSON.stringify(bobSettled.messages?.slice(-3))).toBe("settled");
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Say hello", threadId: aliceThread }, cookie: alice });
    expect((await settle(aliceThread, alice)).status).toBe("settled");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await aliceStream.close(); await bobStream.close();
    expect(bobStream.text()).toContain("Bob fixture bug");
    expect(aliceStream.text()).toContain(aliceThread); // the stream is live for Alice
    expect(aliceStream.text()).not.toContain(bobThread);
    expect(aliceStream.text()).not.toContain("Bob fixture bug");
    expect(aliceStream.text()).not.toContain("List my GitHub issues");

    // A member's default conversation with a shared bot is their own.
    const bobDefault = (await request("/api/bots", { cookie: bob })).body.bots.find((item: any) => item.id === bot.id).threadId;
    const aliceDefault = (await request("/api/bots", { cookie: alice })).body.bots.find((item: any) => item.id === bot.id).threadId;
    expect(aliceDefault).not.toBe(bobDefault);
    const sent = await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Say hello without a thread" }, cookie: alice });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    expect(sent.body.threadId ?? aliceDefault).toBe(aliceDefault);
    expect((await settle(aliceDefault, alice)).status).toBe("settled");
    expect(JSON.stringify(await messages(bobDefault, bob))).not.toContain("Say hello without a thread");

    // Memory saved in Alice's private conversation stays hers.
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "remember Alice codename Falcon-7", threadId: aliceThread }, cookie: alice });
    expect((await settle(aliceThread, alice)).status).toBe("settled");
    const systemOf = (item: { body: any }) => JSON.stringify(item.body.messages.filter((m: any) => m.role === "system"));
    const afterRemember = modelRequests.length;
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Say hello", threadId: bobThread }, cookie: bob });
    expect((await settle(bobThread, bob)).status).toBe("settled");
    const leak = modelRequests.slice(afterRemember).map((item) => systemOf(item)).find((text) => text.includes("Falcon-7"));
    expect(leak === undefined, leak?.slice(Math.max(0, leak.indexOf("Falcon-7") - 700), leak.indexOf("Falcon-7") + 200)).toBe(true);
    const beforeAliceRecall = modelRequests.length;
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Say hello", threadId: aliceThread }, cookie: alice });
    expect((await settle(aliceThread, alice)).status).toBe("settled");
    expect(modelRequests.slice(beforeAliceRecall).some((item) => systemOf(item).includes("Falcon-7"))).toBe(true);

    // Shared team rooms stay shared, deliberately.
    const room = (await request("/api/groups", { method: "POST", body: { name: "Shared room", memberIds: [bot.id] }, cookie: alice })).body.group;
    expect(room?.id).toBeTruthy();
    await request(`/api/groups/${room.id}/messages`, { method: "POST", body: { text: "@everyone Team note from Bob" }, cookie: bob });
    await runControlOmb(["wait", "--channel", room.id, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    const roomForAlice = await request(`/api/threads/${room.threadId}/messages`, { cookie: alice });
    expect(roomForAlice.status).toBe(200);
    expect(JSON.stringify(roomForAlice.body)).toContain("Team note from Bob");
    expect((await request("/api/bots", { cookie: alice })).body.groups.some((group: any) => group.id === room.id)).toBe(true);
    // and a room is never a window into a member's private memory
    const roomCalls = modelRequests.filter((item) => JSON.stringify(item.body.messages).includes("Team note from Bob"));
    expect(roomCalls.length, JSON.stringify(roomForAlice.body).slice(0, 1500)).toBeGreaterThan(0);
    expect(roomCalls.some((item) => systemOf(item).includes("Falcon-7"))).toBe(false);

    // F. bot access OFF: no connector tools mount, nothing executes
    const callsBeforeOptOut = mcpCalls.length;
    await owner(`/api/bots/${bot.id}`, "PATCH", { composio: false });
    await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Check my latest emails", threadId: aliceThread }, cookie: alice });
    expect((await wait(bot.id, aliceThread)).status).toBe("settled");
    const offTurn = modelRequests.at(-1)!;
    expect(offTurn.tools.some((name) => name.startsWith("apps_"))).toBe(false);
    expect(mcpCalls.length).toBe(callsBeforeOptOut);
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
    // nor the backend vendor's name, anywhere a member can read (catalog,
    // inventory, transcripts, tool receipts, approval cards, config)
    // The only allowed occurrence is the internal wire field name ("composio":
    // true on a bot, "composio":{configured} in config); never a value or text.
    const vendorHits = memberResponses.join("\n").match(/.{0,120}(?:(?<!")composio|composio(?!":)|ak_[a-z]).{0,60}/gi) ?? [];
    expect(vendorHits, vendorHits.slice(0, 5).join("\n---\n")).toEqual([]);
    expect(JSON.stringify(await messages(aliceThread, alice))).toMatch(/apps_gmail_fetch_emails/);
    // routed model slugs are operator detail, not member-facing
    expect(memberResponses.join("\n")).not.toMatch(/(?:fast|standard|strong)-fixture/);
    writeFileSync(`${fixture.info.logPath}.members.json`, JSON.stringify({ mcpCalls, modelTools: modelRequests.map((item) => item.tools) }, null, 2));
    console.log(`NATION member connector evidence: ${fixture.info.logPath}.members.json`);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
