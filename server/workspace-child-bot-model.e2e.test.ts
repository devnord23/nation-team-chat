// NATION workspace-child path: proves that a client-scoped session on a
// workspace child (WORKSPACE_CHILD = true) can create bots and set
// modelSelection from the nationApi routing catalog, while provider-key and
// instance-admin mutations remain blocked.
//
// Background: when NATION_WORKSPACE_ID + NATION_WORKSPACE_KEY are both set
// the server is a "workspace child" that represents one member's personal
// workspace. In production these children inherit OPENROUTER_API_KEY from the
// parent VPS environment and auto-provision the nationApi (nation-openrouter)
// instance. The test simulates that setup using a loopback OpenRouter stub.
import { closeSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { verificationServerEnvironment, launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Workspace ID in the required format: "ws_" + exactly 22 alphanumeric chars.
const WORKSPACE_ID = "ws_" + "A".repeat(22);
const WORKSPACE_KEY = "k".repeat(43);

let fixture: VerificationServer | undefined;
let child: ChildProcess | undefined;
let openRouterStub: ReturnType<typeof createServer> | undefined;
let openRouterOrigin: string;
const evidence: unknown[] = [];

async function request(
  path: string,
  { method = "GET", body, token }: { method?: string; body?: unknown; token?: string } = {},
) {
  const response = await fetch(`${fixture!.info.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  evidence.push({ method, path, status: response.status, body: result });
  return { status: response.status, body: result };
}

beforeAll(async () => {
  // Minimal loopback stand-in for the OpenRouter API. Returns success for any
  // chat completion request; never a real upstream provider.
  openRouterStub = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    // chat/completions — streaming SSE style
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => openRouterStub!.listen(0, "127.0.0.1", resolve));
  openRouterOrigin = "http://127.0.0.1:" + (openRouterStub!.address() as { port: number }).port;

  // Bootstrap a base fixture (gets us a data directory, port, and log path).
  fixture = await launchVerificationServer();
  child = fixture.child;
  await waitForExit(child, { signal: "SIGTERM" });

  const port = Number(new URL(fixture.info.url).port);
  const childEnv = verificationServerEnvironment({}, fixture.info.dataDir, port);
  Object.assign(childEnv, {
    // Workspace-child identity — activates WORKSPACE_CHILD = true.
    NATION_WORKSPACE_ID: WORKSPACE_ID,
    NATION_WORKSPACE_KEY: WORKSPACE_KEY,
    // OpenRouter key activates nationApi (nation-openrouter) instance.
    OPENROUTER_API_KEY: "nation_fixture_key_only",
    OPENROUTER_API_URL: `${openRouterOrigin}/v1`,
    // Route: strong tier uses a distinct model; fast/standard share the default.
    NATION_MODEL_STRONG: "openai/o4-mini",
  });

  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", log, log],
  });
  closeSync(log);

  await vi.waitFor(
    async () => {
      if (child!.exitCode !== null || child!.signalCode !== null) {
        throw new Error(`Workspace-child fixture exited; see ${fixture!.info.logPath}`);
      }
      const r = await fetch(`${fixture!.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      expect(r.status).toBe(200);
      expect((await r.json() as { pid?: number }).pid).toBe(child!.pid);
    },
    { timeout: 20_000, interval: 200 },
  );
}, 40_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (fixture) {
    const evidencePath = `${fixture.info.logPath}.workspace-child-bot-model.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
  openRouterStub?.closeAllConnections();
  await new Promise<void>((resolve) => openRouterStub?.close(() => resolve()));
});

async function clientToken(): Promise<string> {
  const pairing = await request("/api/auth/pairing", {
    method: "POST",
    body: { scopes: ["client"], label: "Workspace child test client" },
  });
  expect(pairing.status, "pairing").toBe(200);
  const paired = await request("/api/pair", {
    method: "POST",
    body: { code: pairing.body.code, deviceName: "Workspace child test client" },
  });
  expect(paired.status, "pair").toBe(200);
  return paired.body.token as string;
}

it("workspace-child member can POST bots and PATCH modelSelection from the nationApi catalog", async () => {
  const token = await clientToken();

  // 1. GET /api/config returns hostedModelSelection: true and isProductOwner: false.
  const config = await request("/api/config", { token });
  expect(config.status, "GET /api/config").toBe(200);
  expect(config.body.hostedModelSelection, "hostedModelSelection").toBe(true);
  expect(config.body.isProductOwner, "isProductOwner").toBe(false);
  expect(config.body.personalWorkspace, "personalWorkspace").toBe(true);

  // 2. GET /api/instances returns the nationApi instance with routing catalog models.
  const instances = await request("/api/instances", { token });
  expect(instances.status, "GET /api/instances").toBe(200);
  const catalog = instances.body.instances as Array<{
    instanceId: string; driverKind: string; readOnly?: boolean;
    models: { default: string; options: Array<{ id: string; label: string }> };
  }>;
  const nationInst = catalog.find((i) => i.instanceId === "nationApi");
  expect(nationInst, "nationApi instance present").toBeTruthy();
  expect(nationInst!.readOnly, "nationApi is readOnly").toBe(true);
  expect(nationInst!.driverKind, "nation-openrouter driver").toBe("nation-openrouter");
  // The routing catalog has fast (default) and strong tier distinct models.
  expect(nationInst!.models.options.length, "routing catalog has distinct models").toBeGreaterThanOrEqual(2);
  // No Claude/Anthropic slugs in the routing catalog (blocked by resolveNationModel).
  for (const option of nationInst!.models.options) {
    expect(option.id, `no claude/anthropic in routing catalog model ${option.id}`).not.toMatch(/claude|anthropic/i);
  }
  // Token must never appear in the response body.
  expect(JSON.stringify(instances.body)).not.toContain("nation_fixture_key_only");

  // 3. POST /api/bots with the default nationApi model must succeed (201, not 403).
  const defaultModel = nationInst!.models.default;
  const created = await request("/api/bots", {
    method: "POST",
    body: { name: "Chief of Staff", modelSelection: { instanceId: "nationApi", model: defaultModel } },
    token,
  });
  expect(created.status, "client POST /api/bots with nationApi modelSelection").toBe(201);
  expect(created.body.bot.modelSelection.instanceId, "bot has nationApi instance").toBe("nationApi");
  const botId: string = created.body.bot.id;
  const botThreadId: string = created.body.bot.threadId;

  // 4. POST /api/bots with an unassigned / invalid model must be rejected (400).
  const badCreate = await request("/api/bots", {
    method: "POST",
    body: { name: "Bad bot", modelSelection: { instanceId: "nationApi", model: "not/in-catalog" } },
    token,
  });
  expect(badCreate.status, "client POST /api/bots with invalid model").toBe(400);

  // 5. PATCH /api/bots/:id with a valid nationApi model must succeed (200).
  const strongModel = nationInst!.models.options.find((o) => o.id !== defaultModel)?.id ?? defaultModel;
  const patch = await request(`/api/bots/${botId}`, {
    method: "PATCH",
    body: { modelSelection: { instanceId: "nationApi", model: strongModel } },
    token,
  });
  expect(patch.status, "client PATCH /api/bots/:id modelSelection").toBe(200);

  // 6. PATCH /api/bots/:id with forbidden field alongside modelSelection must be 403.
  const mixedPatch = await request(`/api/bots/${botId}`, {
    method: "PATCH",
    body: { modelSelection: { instanceId: "nationApi", model: defaultModel }, cwd: "/tmp" },
    token,
  });
  expect(mixedPatch.status, "client PATCH /api/bots/:id with cwd").toBe(403);

  // 7. PATCH task modelSelection must succeed (200).
  const taskPatch = await request(`/api/bots/${botId}/tasks/${botThreadId}`, {
    method: "PATCH",
    body: { modelSelection: { instanceId: "nationApi", model: defaultModel } },
    token,
  });
  expect(taskPatch.status, "client PATCH task modelSelection").toBe(200);

  // 8. Provider-key / instance admin routes remain 403.
  for (const [method, path, body] of [
    ["PATCH", "/api/instances/nationApi", { cli: "forbidden" }],
    ["PUT", "/api/config", { anthropic: { key: "forbidden-key" } }],
  ] as const) {
    const denied = await request(path, { method, body, token });
    expect(denied.status, `client ${method} ${path} (must be 403)`).toBe(403);
  }

  // 9. The operator (loopback, admin) sees admin config — isProductOwner: true.
  const adminConfig = await request("/api/config");
  expect(adminConfig.body.isProductOwner).toBe(true);
  // Admin GET /api/instances returns the real full catalog.
  const adminInstances = await request("/api/instances");
  const adminNation = adminInstances.body.instances?.find((i: any) => i.instanceId === "nationApi");
  expect(adminNation).toBeTruthy();
}, 30_000);
