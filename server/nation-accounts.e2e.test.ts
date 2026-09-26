// Public sign-up on the founder's server, through the real HTTP API:
//   - an emailed one-time link signs a stranger in and creates a workspace of
//     their own, served by its own server over its own data directory;
//   - two accounts never see each other's bots, conversations or credit, and
//     neither sees the founder's desk; the founder still signs in to the desk;
//   - a new account is on the free plan with its starter credit, and its
//     Starter invoice pays the founder treasury on Robinhood Chain from the
//     one shared ledger;
//   - an account cookie never falls through to the desk: a stale one, a
//     cross-site one and forged owner headers are all refused.
// Every external service is an owned loopback stand-in.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

const FOUNDER = "founder@example.test";
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const TREASURY = "0x85E3C2D8f776d9D05b14E108F368070CbD8C1639";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const accountId = (email: string) => "email:" + createHash("sha256").update(email).digest("hex");

type Reply = { status: number; body: any; text: string };

/** One browser: its own cookie jar, and the Origin a page on the app sends. */
function browser(base: string) {
  const jar = new Map<string, string>();
  const request = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; origin?: string | null } = {}): Promise<Reply> => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    const response = await fetch(base + path, {
      method: init.method ?? "GET",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.origin === null ? {} : { origin: init.origin ?? base }),
        ...(cookie ? { cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq).trim();
      if (attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute))) jar.delete(name);
      else jar.set(name, pair!.slice(eq + 1).trim());
    }
    const text = await response.text();
    let body: any = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    return { status: response.status, body, text };
  };
  return { jar, request };
}

it("gives every email its own workspace and keeps the founder desk out of reach", async () => {
  const prompts: string[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (String(req.url).endsWith("/chat/completions")) {
      prompts.push(raw);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "Hello from your teammate." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }); res.end("{}");
  });
  // Robinhood Chain (4663) stand-in: enough for an invoice and an empty scan.
  const chain = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const answer = (call: { id: unknown; method: string }) => ({
      jsonrpc: "2.0", id: call.id,
      ...(call.method === "eth_chainId" ? { result: "0x1237" }
        : call.method === "eth_blockNumber" ? { result: "0x100" }
        : call.method === "eth_getLogs" ? { result: [] }
        : { error: { code: -32601, message: "unsupported" } }),
    });
    const body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  });
  await Promise.all([provider, chain].map((server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))));
  const origin = (server: typeof provider) => `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin(provider), undefined, undefined, undefined, { founderEmails: [FOUNDER], payments: { rpc: origin(chain), treasury: TREASURY } });
  const base = fixture.info.url;
  const outbox = join(fixture.info.dataDir, "mail-outbox");
  const linkFor = (email: string): string => {
    const files = existsSync(outbox) ? readdirSync(outbox).sort() : [];
    for (const file of files.reverse()) {
      const message = JSON.parse(readFileSync(join(outbox, file), "utf8"));
      if (message.to === email) return message.link as string;
    }
    throw new Error(`no sign-in email for ${email}`);
  };
  const signIn = async (who: ReturnType<typeof browser>, email: string) => {
    expect((await who.request("/api/auth/magic/start", { method: "POST", body: { email } })).status).toBe(200);
    const link = linkFor(email);
    expect(link.startsWith(`${base}/#login=nml_`)).toBe(true);
    const token = decodeURIComponent(link.split("#login=")[1]!);
    expect((await who.request("/api/auth/magic/peek", { method: "POST", body: { token } })).body).toEqual({ email });
    const verified = await who.request("/api/auth/magic/verify", { method: "POST", body: { token, label: "Fixture browser" } });
    expect(verified.status, verified.text).toBe(200);
    return { token, verified: verified.body };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    expect(response.status, `${method} ${path} ${text}`).toBeLessThan(300);
    return text ? JSON.parse(text) : {};
  };

  try {
    // The founder's desk already has teammates and history.
    const echo = (await owner("/api/bots", "POST", { name: "Echo" })).bot;
    await owner("/api/bots", "POST", { name: "Pebble" });
    const founderNames = (await owner("/api/bots")).bots.map((bot: any) => bot.name);
    expect(founderNames).toEqual(expect.arrayContaining(["Echo", "Pebble"]));

    // The environment tells the app to show email sign-in.
    const environment = await (await fetch(`${base}/.well-known/nationteamchat/environment`)).json() as any;
    expect(environment.capabilities.accountSignIn).toBe(true);

    // 1. Alice: a link, then her own new workspace.
    const alice = browser(base);
    const aliceLink = await signIn(alice, ALICE);
    expect(aliceLink.verified).toEqual({ ok: true, destination: "workspace", created: true });
    expect(alice.jar.has("nation_account")).toBe(true);
    // The link worked once.
    expect((await alice.request("/api/auth/magic/verify", { method: "POST", body: { token: aliceLink.token } })).status).toBe(401);
    const aliceSession = (await alice.request("/api/auth/session")).body;
    expect(aliceSession).toMatchObject({ kind: "session", scopes: ["client"], email: ALICE });
    const aliceBots = await alice.request("/api/bots");
    expect(aliceBots.status, aliceBots.text).toBe(200);
    expect(aliceBots.body.bots.map((bot: any) => bot.name)).not.toEqual(expect.arrayContaining(["Echo"]));
    expect(aliceBots.body.bots.map((bot: any) => bot.name)).not.toContain("Pebble");
    // …served by another process than the desk
    const health = await alice.request("/api/health");
    expect(health.body.app).toBe("nation-team-chat");
    expect(health.body.pid).not.toBe(fixture.info.pid);

    // 4. Free plan, starter credit, never exempt.
    const credits = await alice.request("/api/credits/status");
    expect(credits.status, credits.text).toBe(200);
    expect(credits.body).toMatchObject({ exempt: false, onFreePlan: true, plan: "free", starterCreditUsd: 3, starterGranted: true, verified: true });
    expect(credits.body.balanceUsd).toBe(3);
    // A Starter invoice in USDG pays the founder treasury on Robinhood Chain.
    const invoice = await alice.request("/api/credits/invoices", { method: "POST", body: { chain: 4663, packUsd: 15, token: USDG } });
    expect(invoice.status, invoice.text).toBe(201);
    expect(invoice.body).toMatchObject({ chain: 4663, treasury: TREASURY, symbol: "USDG" });
    expect(Number(invoice.body.amount)).toBeGreaterThanOrEqual(15);
    expect(Number(invoice.body.amount)).toBeLessThan(16);

    // Her own teammate, and a conversation with it.
    const scout = (await alice.request("/api/bots", { method: "POST", body: { name: "Alice Scout" } })).body.bot;
    expect(scout?.name).toBe("Alice Scout");
    const sent = await alice.request(`/api/bots/${scout.id}/messages`, { method: "POST", body: { text: "Plan my launch week" } });
    expect(sent.status, sent.text).toBeLessThan(300);
    await expect.poll(async () => {
      const messages = (await alice.request(`/api/threads/${scout.threadId}/messages`)).body.messages ?? [];
      return messages.some((message: any) => message.role === "bot" && /Hello from your teammate/.test(message.text ?? ""));
    }, { timeout: 30_000, interval: 250 }).toBe(true);
    expect(prompts.join("\n")).toContain("Plan my launch week");

    // 2. Bob: his own workspace, none of Alice's.
    const bob = browser(base);
    expect((await signIn(bob, BOB)).verified).toEqual({ ok: true, destination: "workspace", created: true });
    const bobBots = (await bob.request("/api/bots")).body.bots.map((bot: any) => bot.name);
    expect(bobBots).not.toContain("Alice Scout");
    expect(bobBots).not.toContain("Echo");
    expect((await bob.request(`/api/threads/${scout.threadId}/messages`)).status).toBe(404);
    expect((await bob.request(`/api/bots/${scout.id}/messages`, { method: "POST", body: { text: "hi" } })).status).toBe(404);
    const bobCredits = (await bob.request("/api/credits/status")).body;
    expect(bobCredits.invoices).toEqual([]);
    expect(bobCredits.onFreePlan).toBe(true);
    // Bob can reach neither the desk's teammates nor its admin routes.
    expect((await bob.request(`/api/threads/${echo.threadId}/messages`)).status).toBe(404);
    expect((await bob.request("/api/admin/credits")).status).toBe(403);
    expect((await bob.request("/api/config", { method: "PUT", body: { profile: { name: "Bob" } } })).status).toBe(403);
    // Forged owner and proxy headers change nothing.
    const forged = await bob.request("/api/admin/credits", { headers: { "x-openmausbot-desktop-owner": "1", "x-forwarded-for": "127.0.0.1", "x-nation-workspace-key": "forged" } });
    expect(forged.status).toBe(403);
    // A page on another site cannot ride Bob's cookie.
    expect((await bob.request("/api/bots", { origin: "https://evil.example" })).status).toBe(403);

    // Separate data roots: each workspace holds only its own teammates.
    const roots = readdirSync(join(fixture.info.dataDir, "workspaces")).filter((name) => name.startsWith("ws_"));
    expect(roots).toHaveLength(2);
    const holding = (text: string) => roots.filter((name) => {
      const file = join(fixture.info.dataDir, "workspaces", name, "bots.json");
      return existsSync(file) && readFileSync(file, "utf8").includes(text);
    });
    expect(holding("Alice Scout")).toHaveLength(1);
    expect(holding("Echo")).toHaveLength(0);
    expect(readFileSync(join(fixture.info.dataDir, "bots.json"), "utf8")).not.toContain("Alice Scout");

    // One ledger for everyone: Alice's invoice, on Alice's account.
    const ledger = new DatabaseSync(join(fixture.info.dataDir, "nation-credits.db"), { readOnly: true });
    try {
      const rows = ledger.prepare("SELECT user_id, chain, treasury FROM credit_invoices").all();
      expect(rows).toEqual([{ user_id: accountId(ALICE), chain: 4663, treasury: TREASURY.toLowerCase() }]);
    } finally {
      ledger.close();
    }

    // 3. The founder signs in to the desk with the same kind of link.
    const founder = browser(base);
    expect((await signIn(founder, FOUNDER)).verified).toEqual({ ok: true, destination: "desk" });
    expect(founder.jar.has("nation_account")).toBe(false);
    const founderSession = (await founder.request("/api/auth/session")).body;
    expect(founderSession.scopes).toContain("admin");
    const deskNames = (await founder.request("/api/bots")).body.bots.map((bot: any) => bot.name);
    expect(deskNames).toEqual(expect.arrayContaining(["Echo", "Pebble"]));
    expect(deskNames).not.toContain("Alice Scout");
    expect((await founder.request("/api/credits/status")).body.exempt).toBe(true);

    // A stale account cookie never falls through to the desk, not even on loopback.
    const stale = browser(base);
    stale.jar.set("nation_account", "nas_" + "A".repeat(43));
    const refused = await stale.request("/api/bots", { origin: null });
    expect(refused.status).toBe(401);
    expect(refused.text).not.toContain("Echo");

    // Signing out ends the account session.
    expect((await alice.request("/api/auth/logout", { method: "POST", body: {} })).status).toBe(200);
    expect(alice.jar.has("nation_account")).toBe(false);
    const again = browser(base);
    again.jar.set("nation_account", "gone");
    expect((await again.request("/api/bots")).status).toBe(401);
  } finally {
    await fixture.close();
    await Promise.all([provider, chain].map((server) => new Promise((resolve) => server.close(resolve))));
  }
}, 180_000);
