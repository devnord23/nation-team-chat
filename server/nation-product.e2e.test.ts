import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("NATION defaults, member privacy, validation and first-message team replies", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, ["hermes"]);
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const call = async (path: string, method = "GET", body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    requests.push({ method, path, status: response.status });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const selection = { instanceId: "hermes", model: "openrouter/auto" }; // repository fake CLI, no external service
    expect((await call("/api/config", "PUT", { defaultModelSelection: selection, vps: { sshAlias: "localhost" } })).status).toBe(200);
    const first = await call("/api/bots", "POST", { name: "Coordinator" });
    expect(first.status).toBe(201);
    expect(first.body.bot).toMatchObject({ modelSelection: selection, computer: "cloud", cloudBackend: "vps" });
    const second = (await call("/api/bots", "POST", { name: "Researcher" })).body.bot;
    for (const bot of [first.body.bot, second]) {
      expect((await call(`/api/bots/${bot.id}`, "PATCH", { computer: "off" })).status).toBe(200);
    }
    const pairing = await call("/api/auth/pairing", "POST", { scopes: ["client"], label: "Member fixture" });
    expect(pairing.status).toBe(200);
    const paired = await call("/api/pair", "POST", { code: pairing.body.code, deviceName: "Member fixture" });
    expect(paired.status).toBe(200);
    const token = paired.body.token;
    for (const path of ["/api/config", "/api/instances", "/api/bots", "/api/brand"]) {
      const response = await call(path, "GET", undefined, token);
      expect(response.status, path).toBe(200);
      expect(JSON.stringify(response.body), path).not.toMatch(/openrouter|hermes|claude|anthropic|grok|xai|venice|\.openmausbot|whitelabel/i);
      if (path === "/api/config") expect(response.body.isProductOwner).toBe(false);
    }
    for (const path of ["/api/admin/openrouter/status", "/api/instances/claude/auth/status", "/api/edition"]) {
      expect((await call(path, "GET", undefined, token)).status, path).toBe(403);
    }
    for (const path of [`/api/bots/${second.id}`, `/api/bots/${second.id}/model`, `/api/bots/${second.id}/tasks/${second.threadId}`]) {
      expect((await call(path, "PATCH", { modelSelection: selection }, token)).status, path).toBe(403);
    }
    const streamAbort = new AbortController();
    const streamTimeout = setTimeout(() => streamAbort.abort(), 5_000);
    const stream = await fetch(`${fixture.info.url}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: streamAbort.signal });
    const reader = stream.body!.getReader();
    let streamed = new TextDecoder().decode((await reader.read()).value);
    const cursor = JSON.parse(streamed.split("data: ")[1].split("\n")[0]).cursor;
    expect((await call("/api/bots", "POST", { name: "Member agent" }, token)).status).toBe(201);
    while (!streamed.includes('"kind":"bot"')) streamed += new TextDecoder().decode((await reader.read()).value);
    expect(streamed).toContain("NATION API");
    expect(streamed).not.toMatch(/hermes|openrouter|claude|anthropic/i);
    await reader.cancel(); streamAbort.abort(); clearTimeout(streamTimeout);
    const replay = await fetch(`${fixture.info.url}/api/events?since=${encodeURIComponent(cursor)}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000),
    });
    const replayReader = replay.body!.getReader();
    let replayed = "";
    while (!replayed.includes('"kind":"bot"')) replayed += new TextDecoder().decode((await replayReader.read()).value);
    expect(replayed).toContain("NATION API");
    expect(replayed).not.toMatch(/hermes|openrouter|claude|anthropic/i);
    await replayReader.cancel();
    for (const invalid of [{ instanceId: "missing-engine", model: "missing-model" }, { instanceId: "hermes", model: "missing-model" }]) {
      const response = await call(`/api/bots/${second.id}`, "PATCH", { modelSelection: invalid });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/^NATION:/);
      expect(response.body.error).not.toContain("missing-");
    }
    const group = (await call("/api/groups", "POST", { name: "NATION team", memberIds: [first.body.bot.id, second.id] }, token)).body.group;
    expect(group?.id).toBeTruthy();
    const sent = await call(`/api/groups/${group.id}/messages`, "POST", { text: "@Coordinator @Researcher reply to this check" }, token);
    expect(sent.status).toBe(202);
    const settled = await runControlOmb(["wait", "--channel", group.id, "--timeout", "30"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
    expect(settled.status).toBe("settled");
    const state = await call("/api/bots", "GET", undefined, token);
    const savedGroup = state.body.groups.find((item: any) => item.id === group.id);
    expect(savedGroup.setupSkippedAt).toEqual(expect.any(Number));
    const messages = (await call(`/api/threads/${group.threadId}/messages`, "GET", undefined, token)).body.messages;
    const speakers = new Set(messages.filter((m: any) => m.kind === "text" && m.role === "bot").map((m: any) => m.from?.botId));
    expect(speakers.has(first.body.bot.id)).toBe(true);
    expect(speakers.has(second.id)).toBe(true);
    const persisted = JSON.parse(readFileSync(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(persisted.defaultModelSelection).toEqual(selection);
    writeFileSync(`${fixture.info.logPath}.nation.json`, JSON.stringify({ requests, settled, messages }, null, 2));
    console.log(`NATION evidence: ${fixture.info.logPath}.nation.json`);
  } finally { await fixture.close(); }
}, 60_000);
