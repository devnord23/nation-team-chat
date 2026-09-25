// Hosted NATION Team Map privacy over HTTP. Bob's private conversation makes
// his bot delegate work to a teammate; while that delegated turn runs, the
// Team Map is read as Alice, as Bob and as the operator. Every external
// service is an owned loopback stand-in. Proves: Alice's Team Map contains
// neither the delegation edge, its conversation, nor its private label/text,
// with or without forged owner/admin/companion headers or cookies; Bob sees
// his own delegation; the operator sees everything (intended policy).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const ALICE = "alice.map@example.test";
const BOB = "bob.map@example.test";
const SECRET = "Q7-PAYROLL-AUDIT";

it("the Team Map never shows one member another member's private delegation", async () => {
  let releaseHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let heldStarted = false;
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
      return json({ user: { id: "acct_" + body.email.split("@")[0], email: body.email } }, 200, { "set-auth-token": "fixture_" + randomBytes(12).toString("hex") });
    }
    if (url.pathname === "/api/auth/sign-out") return json({ success: true });
    if (url.pathname.startsWith("/api/v3")) return json({ items: [] });
    if (url.pathname.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      const system = JSON.stringify(body.messages.filter((item: any) => item.role === "system"));
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user");
      const asked = JSON.stringify(lastUser?.content ?? "");
      const replies = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1).filter((item: any) => item.role === "tool");
      let delta: Record<string, unknown>;
      if (system.includes("You are Clerk") && asked.includes(SECRET)) {
        // the delegated turn: hold it open while the test reads the Team Map
        heldStarted = true;
        await held;
        delta = { content: "Audit done." };
      } else if (/delegate the audit/.test(asked) && tools.includes("agents_coordinate_bots") && replies.length === 0) {
        delta = { tool_calls: [{ index: 0, id: `d-${++callSeq}`, type: "function", function: { name: "agents_coordinate_bots",
          arguments: JSON.stringify({ bot_ids: [clerkId], message: `Run ${SECRET} for Bob's salary file`, request_key: "audit-1", label: `${SECRET} label` }) } }] };
      } else {
        delta = { content: "Sent." };
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    json({ error: "not found" }, 404);
  });
  let clerkId = "";
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin, undefined, { providerApi: origin, memberEmails: [ALICE, BOB] });
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
  const signIn = async (email: string) => {
    expect((await request("/api/auth/email/start", { method: "POST", body: { email } })).status).toBe(200);
    const response = await fetch(fixture.info.url + "/api/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: "12345678", label: email }) });
    return String(response.headers.get("set-cookie")).split(";")[0];
  };
  const forged = {
    "x-openmausbot-desktop-owner": "1", "x-openmausbot-companion": "1", "x-openmausbot-companion-auth": "forged",
    "x-openmausbot-companion-device": "forged", "x-forwarded-for": "127.0.0.1", "x-nation-admin": "1",
  };
  try {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    for (const [cookie, email] of [[alice, ALICE], [bob, BOB]]) {
      await request("/api/credits/status", { cookie });
      await owner("/api/admin/credits/adjust", "POST", { userId: "email:" + createHash("sha256").update(email).digest("hex"), amountUsd: 5, reason: "fixture credit" });
    }
    const { bot: lead } = await owner("/api/bots", "POST", { name: "Lead" });
    const { bot: clerk } = await owner("/api/bots", "POST", { name: "Clerk" });
    clerkId = clerk.id;
    for (const bot of [lead, clerk]) await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "off", composio: false, autoApprove: true });
    const bobThread = (await request(`/api/bots/${lead.id}/tasks`, { method: "POST", body: { title: "Private audit" }, cookie: bob })).body.task.threadId as string;
    expect((await request(`/api/bots/${lead.id}/messages`, { method: "POST", body: { text: "delegate the audit", threadId: bobThread }, cookie: bob })).status).toBeLessThan(300);
    for (let i = 0; i < 200 && !heldStarted; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const open = ((await request(`/api/threads/${bobThread}/messages`, { cookie: bob })).body.messages as any[]).find((item) => item.card?.requestId && !item.card.answered)?.card;
      if (open) await request(`/api/bots/${lead.id}/respond`, { method: "POST", body: { threadId: bobThread, requestId: open.requestId, behavior: "allow" }, cookie: bob });
    }
    expect(heldStarted, JSON.stringify((await request(`/api/threads/${bobThread}/messages`, { cookie: bob })).body.messages?.map((m: any) => [m.role, m.kind, m.text?.slice(0, 200), m.tool?.name, m.card?.tool])).slice(0, 2500)).toBe(true);

    // While the delegation runs. NATION API turns delegate with
    // coordinate_bots, which gives the teammate its own conversation with the
    // delegating bot; /api/team-map's legacy queue stays empty for it, so the
    // private data a member could reach is that conversation: its id, title,
    // text, and the edge it implies. The operator sees it (intended policy)...
    const clerkTasks = (bots: any) => (bots.bots as any[]).find((item) => item.id === clerk.id)?.tasks ?? [];
    const operatorBots = await owner("/api/bots");
    const delegated = clerkTasks(operatorBots).find((task: any) => task.openedBy?.botId === lead.id);
    expect(delegated, JSON.stringify(clerkTasks(operatorBots))).toBeTruthy();
    const delegatedThread = delegated.threadId as string;
    expect(JSON.stringify(await owner(`/api/threads/${delegatedThread}/messages`))).toContain(SECRET);
    // ...Bob sees his own delegated conversation...
    const bobBots = (await request("/api/bots", { cookie: bob })).body;
    expect(clerkTasks(bobBots).some((task: any) => task.threadId === delegatedThread)).toBe(true);
    expect((await request(`/api/threads/${delegatedThread}/messages`, { cookie: bob })).text).toContain(SECRET);
    const bobMap = (await request("/api/team-map", { cookie: bob }));
    expect(bobMap.status).toBe(200);
    expect(JSON.stringify(bobMap.body)).toBe(JSON.stringify(await owner("/api/team-map")));
    // ...and Alice sees none of it: no edge, conversation, title or text,
    // whatever she forges.
    for (const [who, init] of [["plain", { cookie: alice }], ["forged headers", { cookie: alice, headers: forged }],
      ["forged cookie", { cookie: `${alice}; nation.adminUnlocked=1; nation_admin=1`, headers: forged }]] as const) {
      const map = await request("/api/team-map", init);
      expect(map.status, who).toBe(200);
      expect(map.body, who).toEqual({ collaborations: [], queued: [], running: [] });
      const bots = await request("/api/bots", init);
      expect(bots.status, who).toBe(200);
      expect(clerkTasks(bots.body).some((task: any) => task.threadId === delegatedThread || task.threadId === bobThread), who).toBe(false);
      for (const reply of [map, bots, await request(`/api/search?q=${SECRET}`, init)]) {
        expect(reply.text, who).not.toContain(SECRET);
        expect(reply.text, who).not.toContain(delegatedThread);
        expect(reply.text, who).not.toContain(bobThread);
      }
      for (const id of [bobThread, delegatedThread]) {
        expect((await request(`/api/threads/${id}/messages`, init)).status, `${who} ${id}`).toBe(404);
      }
    }
    // Alice's own delegation from the same bot pair gets its own conversation,
    // never Bob's (one per account, not one per bot pair).
    releaseHeld();
    await runControlOmb(["wait", "--bot", clerk.id, "--task", delegatedThread, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    await runControlOmb(["wait", "--bot", lead.id, "--task", bobThread, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    const aliceThread = (await request(`/api/bots/${lead.id}/tasks`, { method: "POST", body: { title: "Alice audit" }, cookie: alice })).body.task.threadId as string;
    await request(`/api/bots/${lead.id}/messages`, { method: "POST", body: { text: "delegate the audit", threadId: aliceThread }, cookie: alice });
    let aliceDelegated: string | undefined;
    for (let i = 0; i < 200 && !aliceDelegated; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const open = ((await request(`/api/threads/${aliceThread}/messages`, { cookie: alice })).body.messages as any[]).find((item) => item.card?.requestId && !item.card.answered)?.card;
      if (open) await request(`/api/bots/${lead.id}/respond`, { method: "POST", body: { threadId: aliceThread, requestId: open.requestId, behavior: "allow" }, cookie: alice });
      aliceDelegated = clerkTasks((await request("/api/bots", { cookie: alice })).body).find((task: any) => task.openedBy?.botId === lead.id)?.threadId;
    }
    expect(aliceDelegated).toBeTruthy();
    expect(aliceDelegated).not.toBe(delegatedThread);
    expect((await request(`/api/threads/${aliceDelegated}/messages`, { cookie: bob })).status).toBe(404);
    // and each delegated turn was billed to the member who delegated it
    const ledger = (await owner("/api/admin/credits")).ledger as Array<{ user_id: string; amount_micros: number }>;
    const spent = (email: string) => ledger.filter((row) => row.user_id === "email:" + createHash("sha256").update(email).digest("hex") && row.amount_micros < 0).length;
    expect(spent(BOB)).toBeGreaterThan(0);
    expect(spent(ALICE)).toBeGreaterThan(0);
  } finally {
    releaseHeld();
    await runControlOmb(["wait", "--bot", clerkId || "none", "--timeout", "10"], { env: { OPENMAUSBOT_URL: fixture.info.url } }).catch(() => undefined);
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
