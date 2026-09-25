// Hosted NATION: an uploaded file belongs to the conversation it was shared
// in. Two signed-in members and the operator on one workspace; every
// external service is an owned loopback stand-in. Proves: a member opens
// their own uploads and files in conversations they can see; another
// member's file id, fetched directly, reads as missing (404) with or without
// forged owner/admin headers; a member cannot hand another member's file,
// an unowned legacy file, or a host path to an agent inside a message; the
// operator and a single-user install keep their access.
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const ALICE = "alice.files@example.test";
const BOB = "bob.files@example.test";
// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

it("attachments follow their conversation across hosted members", async () => {
  const modelPrompts: string[] = [];
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
      modelPrompts.push(JSON.stringify(body.messages));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta: { content: "Got it." }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin, undefined, { providerApi: origin, memberEmails: [ALICE, BOB] });
  const request = async (path: string, init: { method?: string; body?: unknown; raw?: Buffer; type?: string; cookie?: string; headers?: Record<string, string> } = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method: init.method ?? "GET",
      headers: { "content-type": init.type ?? "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
      ...(init.raw ? { body: new Uint8Array(init.raw) } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let parsed: any = {};
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { parsed = {}; }
    return { status: response.status, body: parsed, bytes };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const r = await request(path, { method, body });
    expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  const signIn = async (email: string) => {
    expect((await request("/api/auth/email/start", { method: "POST", body: { email } })).status).toBe(200);
    const response = await fetch(fixture.info.url + "/api/auth/email/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: "12345678", label: email }),
    });
    return String(response.headers.get("set-cookie")).split(";")[0];
  };
  const forged = {
    "x-openmausbot-desktop-owner": "1", "x-openmausbot-companion": "1", "x-openmausbot-companion-auth": "forged",
    "x-forwarded-for": "127.0.0.1", "x-nation-admin": "1",
  };
  try {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    for (const [cookie, email] of [[alice, ALICE], [bob, BOB]]) {
      await request("/api/credits/status", { cookie });
      await owner("/api/admin/credits/adjust", "POST", { userId: "email:" + createHash("sha256").update(email).digest("hex"), amountUsd: 5, reason: "fixture credit" });
    }
    const { bot } = await owner("/api/bots", "POST", { name: "Shared reader" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "off", composio: false, autoApprove: false });
    const thread = async (cookie: string, title: string) => (await request(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title }, cookie })).body.task.threadId as string;
    const settle = async (threadId: string) => runControlOmb(["wait", "--bot", bot.id, "--task", threadId, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    const upload = async (cookie: string) => {
      const r = await request("/api/attachments", { method: "POST", raw: PNG, type: "image/png", cookie });
      expect(r.status).toBe(201);
      return r.body.path as string;
    };
    const nameOf = (path: string) => path.split(/[\\/]/).at(-1)!;
    const tag = (path: string) => `<attached-image path="${path}" name="photo.png" />`;

    // Alice uploads and shares a picture in her own conversation.
    const aliceThread = await thread(alice, "Alice photos");
    const alicePath = await upload(alice);
    const aliceName = nameOf(alicePath);
    expect((await request(`/api/attachments/${aliceName}`, { cookie: alice })).status).toBe(200);
    const sent = await request(`/api/bots/${bot.id}/messages`, { method: "POST", cookie: alice, body: { threadId: aliceThread, text: `look at this\n\n${tag(alicePath)}` } });
    expect(sent.status).toBeLessThan(300);
    await settle(aliceThread);
    expect((await request(`/api/attachments/${aliceName}`, { cookie: alice })).status).toBe(200);
    const aliceMessage = ((await request(`/api/threads/${aliceThread}/messages`, { cookie: alice })).body.messages as any[]).find((item) => item.role === "user" && String(item.text).includes(aliceName));
    expect(aliceMessage).toBeTruthy();

    // Bob, with the exact id: missing, with or without forged headers, on
    // every route that could serve or reference it.
    for (const headers of [undefined, forged]) {
      const direct = await request(`/api/attachments/${aliceName}`, { cookie: bob, headers });
      expect(direct.status).toBe(404);
      expect(direct.bytes.equals(PNG)).toBe(false);
      // (message-file routes are operator-only for members: refused before any lookup)
      expect([403, 404]).toContain((await request(`/api/threads/${aliceThread}/messages/${aliceMessage.id}/file?preview=1&ref=0`, { cookie: bob, headers })).status);
      expect([403, 404]).toContain((await request(`/api/threads/${aliceThread}/messages/${aliceMessage.id}/file`, { method: "POST", cookie: bob, headers, body: { path: alicePath } })).status);
    }
    // Nor can Bob hand Alice's file to the shared bot in his own conversation.
    const bobThread = await thread(bob, "Bob photos");
    const promptsBefore = modelPrompts.length;
    for (const headers of [undefined, forged]) {
      const smuggle = await request(`/api/bots/${bot.id}/messages`, { method: "POST", cookie: bob, headers, body: { threadId: bobThread, text: `describe\n\n${tag(alicePath)}` } });
      expect(smuggle.status).toBe(404);
    }
    // ...or a host path.
    expect((await request(`/api/bots/${bot.id}/messages`, { method: "POST", cookie: bob, body: { threadId: bobThread, text: `<attached-file path="/etc/passwd" name="p" />` } })).status).toBe(404);
    expect(modelPrompts.slice(promptsBefore).join("")).not.toContain(aliceName);
    expect(((await request(`/api/threads/${bobThread}/messages`, { cookie: bob })).body.messages as any[]).some((item) => String(item.text ?? "").includes(aliceName))).toBe(false);

    // Bob's own upload works for Bob and is missing for Alice.
    const bobPath = await upload(bob);
    const bobName = nameOf(bobPath);
    expect((await request(`/api/attachments/${bobName}`, { cookie: bob })).status).toBe(200);
    expect((await request(`/api/bots/${bot.id}/messages`, { method: "POST", cookie: bob, body: { threadId: bobThread, text: `mine\n\n${tag(bobPath)}` } })).status).toBeLessThan(300);
    await settle(bobThread);
    expect((await request(`/api/attachments/${bobName}`, { cookie: alice })).status).toBe(404);
    expect((await request(`/api/attachments/${bobName}`, { cookie: alice, headers: forged })).status).toBe(404);

    // A file from before ownership was recorded, shared nowhere a member can
    // see: missing for members, still served to the operator.
    const legacyName = `${randomBytes(16).toString("hex").replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5")}.png`;
    writeFileSync(join(fixture.info.dataDir, "attachments", legacyName), PNG);
    expect((await request(`/api/attachments/${legacyName}`, { cookie: alice })).status).toBe(404);
    expect((await request(`/api/attachments/${legacyName}`, { cookie: bob, headers: forged })).status).toBe(404);
    const legacyPath = join(fixture.info.dataDir, "attachments", legacyName);
    expect((await request(`/api/bots/${bot.id}/messages`, { method: "POST", cookie: alice, body: { threadId: aliceThread, text: tag(legacyPath) } })).status).toBe(404);

    // The operator keeps access to everything (single-user behavior unchanged).
    for (const name of [aliceName, bobName, legacyName]) {
      const served = await request(`/api/attachments/${name}`);
      expect(served.status).toBe(200);
      expect(served.bytes.equals(PNG)).toBe(true);
    }
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 120_000);
