// Hosted NATION: two members use one bot whose configured engine is a local
// CLI (Claude fixture) and whose operator set a host project folder holding
// a secret file. Every external service is an owned loopback stand-in.
// Proves:
//   - no host CLI process runs for a member (hosted turns route to NATION API);
//   - each member works in their own folders for the bot: a per-account bot
//     folder and a per-conversation working folder, stable across that
//     member's turns and disjoint from the other member's;
//   - a member's turn is never pointed at the operator's project folder, the
//     bot's own folder, or the other member's folders, and the operator's
//     secret file never reaches a member or the model on a member's turn;
//   - forged owner/admin/companion headers change nothing;
//   - the operator's own conversations keep the configured project folder.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const ALICE = "alice.files@example.test";
const BOB = "bob.files@example.test";
const SECRET = "OPERATOR-REPO-SECRET-5k2";

it("hosted members never share a bot's folders, working directory or engine process", async () => {
  const prompts: string[] = [];
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
      prompts.push(JSON.stringify(body.messages));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    json({ error: "not found" }, 404);
  });
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
    // The operator's host project folder, with a secret in it.
    const project = join(fixture.info.dataDir, "operator-project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "SECRET.txt"), SECRET);
    const { bot } = await owner("/api/bots", "POST", { name: "Builder" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "off", composio: false, autoApprove: false, cwd: project });
    expect((await owner("/api/bots")).bots.find((item: any) => item.id === bot.id).modelSelection.instanceId).toBe("claude");

    const locations = (prompt: string) => {
      const match = prompt.match(/File locations for this bot \(absolute paths\): (\{.*?\})\./);
      expect(match, prompt.slice(0, 400)).toBeTruthy();
      return JSON.parse(JSON.parse(`"${match![1]}"`)) as { currentWorkingFolder: string; sharedBotFolder: string; otherThreadFiles: string; configuredProjectFolder?: string };
    };
    const turn = async (cookie: string, threadId: string, headers?: Record<string, string>) => {
      const before = prompts.length;
      expect((await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text: "Build it", threadId }, cookie, headers })).status).toBeLessThan(300);
      expect((await runControlOmb(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any).status).toBe("settled");
      const sent = prompts.slice(before).join("\n");
      return { sent, where: locations(sent) };
    };
    const thread = async (cookie: string, title: string) => (await request(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title }, cookie })).body.task.threadId as string;

    const aliceOne = await thread(alice, "Alice one");
    const aliceTwo = await thread(alice, "Alice two");
    const bobOne = await thread(bob, "Bob one");
    const a1 = await turn(alice, aliceOne);
    const a1again = await turn(alice, aliceOne);
    const a2 = await turn(alice, aliceTwo);
    const b1 = await turn(bob, bobOne);
    const b1forged = await turn(`${bob}; nation.adminUnlocked=1`, bobOne, forged);

    // No host CLI ran for anyone: the turns went to NATION API.
    expect(existsSync(join(fixture.info.dataDir, "fake-claude-dump.json"))).toBe(false);

    // Per-account bot folder, per-conversation working folder, stable.
    expect(a1again.where).toEqual(a1.where);
    expect(a2.where.sharedBotFolder).toBe(a1.where.sharedBotFolder);
    expect(a2.where.currentWorkingFolder).not.toBe(a1.where.currentWorkingFolder);
    expect(b1forged.where).toEqual(b1.where);
    const aliceFolders = [a1.where.sharedBotFolder, a1.where.otherThreadFiles, a1.where.currentWorkingFolder, a2.where.currentWorkingFolder];
    const bobFolders = [b1.where.sharedBotFolder, b1.where.otherThreadFiles, b1.where.currentWorkingFolder];
    for (const folder of aliceFolders) for (const other of bobFolders) {
      expect(folder.startsWith(other) || other.startsWith(folder), `${folder} vs ${other}`).toBe(false);
    }
    for (const where of [a1.where, a2.where, b1.where]) {
      expect(where.currentWorkingFolder.startsWith(where.otherThreadFiles)).toBe(true);
      expect(where.configuredProjectFolder).toBeUndefined();
      expect(where.sharedBotFolder.endsWith(bot.id)).toBe(false);
    }
    for (const { sent } of [a1, a2, b1, b1forged]) {
      expect(sent).not.toContain(project);
      expect(sent).not.toContain(SECRET);
    }
    expect(a1.sent).not.toContain(b1.where.sharedBotFolder);
    expect(b1.sent).not.toContain(a1.where.sharedBotFolder);
    // The folders exist and nothing of Alice's lives under Bob's (or back).
    expect(existsSync(a1.where.currentWorkingFolder) && existsSync(b1.where.currentWorkingFolder)).toBe(true);
    expect(readdirSync(b1.where.otherThreadFiles)).toEqual([bobOne]);
    expect(readdirSync(a1.where.otherThreadFiles).sort()).toEqual([aliceOne, aliceTwo].sort());
    // Members cannot point a conversation at a folder themselves.
    expect((await request(`/api/bots/${bot.id}/tasks/${bobOne}`, { method: "PATCH", body: { cwd: project }, cookie: bob, headers: forged })).status).toBeGreaterThanOrEqual(400);
    expect((await request(`/api/bots/${bot.id}`, { method: "PATCH", body: { cwd: a1.where.currentWorkingFolder }, cookie: bob, headers: forged })).status).toBe(403);

    // The operator's own conversation keeps the configured project folder.
    const operatorThread = (await owner(`/api/bots/${bot.id}/tasks`, "POST", { title: "Operator" })).task.threadId as string;
    const before = prompts.length;
    await owner(`/api/bots/${bot.id}/messages`, "POST", { text: "Build it", threadId: operatorThread });
    await runControlOmb(["wait", "--bot", bot.id, "--task", operatorThread, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    const operatorWhere = locations(prompts.slice(before).join("\n"));
    expect(operatorWhere.configuredProjectFolder).toBe(project);
    expect(operatorWhere.sharedBotFolder.endsWith(bot.id)).toBe(true);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
