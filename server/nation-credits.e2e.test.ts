import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("verified starter credit pays for chat and images and zero prevents provider requests", async () => {
  const requests: any[] = [];
  const provider = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(404); res.end("{}"); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ path: req.url, body });
    expect(req.headers.authorization).toBe("Bearer nation_fixture_key_only");
    expect(body.usage).toEqual({ include: true });
    if (req.url === "/images") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "fixture-image", usage: { cost: 0.1 }, data: [{
        b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
        media_type: "image/png",
      }] }));
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.end([
      { id: `fixture-chat-${requests.length}`, choices: [{ delta: { content: "I am a teammate on Nation Team Chat." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8, cost: requests.length === 1 ? 0.6 : 2.3 } },
    ].map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address() as { port: number };
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, `http://127.0.0.1:${address.port}`);
  let token = "", cookie = "";
  const evidence: any[] = [];
  const memberCaptures: any[] = [];
  const call = async (path: string, method = "GET", body?: unknown, admin = false) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", ...(token && !admin ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const value = await response.json() as any;
    evidence.push({ path, status: response.status, value });
    if (token && !admin && !/^\/api\/(?:auth|pair|credits\/wallet)/.test(path)) memberCaptures.push({ path, status: response.status, value });
    return { status: response.status, body: value };
  };
  try {
    const pairing = await call("/api/auth/pairing", "POST", { scopes: ["client"], label: "Credit fixture" });
    token = (await call("/api/pair", "POST", { code: pairing.body.code, deviceName: "Credit fixture" })).body.token;
    expect(token).toBeTruthy();
    expect((await call("/api/credits/status")).body).toMatchObject({ verified: false, balanceUsd: 0, exempt: false, topUpEnabled: false });
    expect((await call("/api/admin/credits")).status).toBe(403);
    const wallet = privateKeyToAccount(generatePrivateKey());
    const challenge = (await call("/api/credits/wallet/challenge", "POST", { address: wallet.address })).body;
    const signature = await wallet.signMessage({ message: challenge.message });
    expect((await call("/api/credits/wallet/verify", "POST", { challengeId: challenge.challengeId, signature })).status).toBe(200);
    expect((await call("/api/credits/wallet/verify", "POST", { challengeId: challenge.challengeId, signature })).status).toBe(403);
    for (let n = 0; n < 2; n++) expect((await call("/api/credits/status")).body).toMatchObject({ verified: true, balanceUsd: 3, exempt: false });
    const created = await call("/api/bots", "POST", { name: "Credit teammate" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const bot = created.body.bot;
    expect((await call(`/api/bots/${bot.id}`, "PATCH", { computer: "off" }, true)).status).toBe(200);
    const chat = async () => {
      const sent = await call(`/api/bots/${bot.id}/messages`, "POST", { threadId: bot.threadId, text: "Introduce yourself briefly." });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    };
    await chat();
    expect((await call("/api/credits/status")).body.balanceUsd).toBe(2.4);
    const messages = (await call(`/api/threads/${bot.threadId}/messages`)).body;
    expect(JSON.stringify(messages)).toContain("I am a teammate on Nation Team Chat.");
    expect((await call(`/api/bots/${bot.id}/avatar/generate`, "POST", { prompt: "A Nation soft tower face" })).status).toBe(201);
    expect((await call("/api/credits/status")).body.balanceUsd).toBe(2.3);
    await chat();
    expect((await call("/api/credits/status")).body).toMatchObject({ balanceUsd: 0, lowBalance: true });
    const count = requests.length;
    expect((await call(`/api/bots/${bot.id}/messages`, "POST", { threadId: bot.threadId, text: "This must be blocked." })).status).toBe(402);
    expect((await call(`/api/bots/${bot.id}/avatar/generate`, "POST", {})).status).toBe(402);
    expect(requests.length).toBe(count);
    const db = new DatabaseSync(join(fixture.info.dataDir, "nation-credits.db"), { readOnly: true });
    const ledger = db.prepare("SELECT type,amount_micros,cost_micros FROM credit_ledger ORDER BY created_at").all();
    db.close();
    expect(ledger.map(row => row.amount_micros)).toEqual([3_000_000, -600_000, -100_000, -2_300_000]);
    expect(ledger.filter(row => row.type === "usage").map(row => row.cost_micros)).toEqual([600_000, 100_000, 2_300_000]);
    // A pre-existing bot still names the fixture's legacy default engine.
    // Owner exemption must not bypass NATION routing or cost accounting.
    expect((await call("/api/credits/status", "GET", undefined, true)).body).toMatchObject({ exempt: true });
    const ownerSent = await call(`/api/bots/${bot.id}/messages`, "POST", {
      threadId: bot.threadId, text: "Owner verification must use NATION API.",
    }, true);
    expect(ownerSent.status, JSON.stringify(ownerSent.body)).toBe(202);
    await runControlOmb(["wait", "--bot", bot.id, "--timeout", "30"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    expect(requests.length).toBe(count + 1);
    expect((await call("/api/credits/status")).body.balanceUsd).toBe(0);
    const ownerDb = new DatabaseSync(join(fixture.info.dataDir, "nation-credits.db"), { readOnly: true });
    const ownerLedger = ownerDb.prepare("SELECT amount_micros,cost_micros FROM credit_ledger WHERE user_id='nation-operator' AND type='usage'").all();
    ownerDb.close();
    expect(ownerLedger).toEqual([{ amount_micros: 0, cost_micros: 2_300_000 }]);
    writeFileSync(`${fixture.info.logPath}.credits.json`, JSON.stringify({ evidence, ledger, ownerLedger, providerCalls: requests.length }, null, 2));
  } finally {
    if (process.env.NATION_BRAND_CAPTURE_PATH) writeFileSync(process.env.NATION_BRAND_CAPTURE_PATH, JSON.stringify(memberCaptures));
    await fixture.close();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  }
}, 90_000);
