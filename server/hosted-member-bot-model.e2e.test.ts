// Hosted NATION member workspace: proves that a member (client-scoped session)
// can create bots with modelSelection and patch a bot's modelSelection, while
// provider-key and instance-admin routes remain blocked.
//
// This is the critical regression guard for the 403 "NATION: model settings
// are available only in Admin." gate that was previously applied too broadly —
// it should fire only for non-hosted workspaces, or for truly admin-only
// mutations (provider keys, instance config, etc.).
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { verificationServerEnvironment, launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MEMBER = "member.modeltest@example.test";
const TOKEN = `omb_workspace_${"m".repeat(43)}`;
const MODELS = {
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5"],
  openai: [] as string[],
  openrouter: ["fixture/primary", "fixture/secondary"],
};

let fixture: VerificationServer | undefined;
let child: ChildProcess | undefined;
let layer: string | undefined;
let providerServer: ReturnType<typeof createServer> | undefined;
let providerOrigin: string;

const evidence: unknown[] = [];

async function memberRequest(
  cookie: string,
  path: string,
  { method = "GET", body }: { method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${fixture!.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  evidence.push({ method, path, cookie: "***", status: response.status, body: result });
  return { status: response.status, body: result };
}

async function ownerRequest(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${fixture!.info.url}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : {};
  evidence.push({ method, path, status: response.status, body: result });
  return { status: response.status, body: result };
}

beforeAll(async () => {
  // Stand-in for NATION account service (email OTP sign-in) and OpenRouter
  // model calls — never a real provider.
  providerServer = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const jsonResponse = (value: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return jsonResponse({ status: true });
    if (url.pathname === "/api/auth/sign-in/email-otp") {
      return jsonResponse(
        { user: { id: "acct_" + body.email.split("@")[0], email: body.email } },
        200,
      );
    }
    if (url.pathname === "/api/auth/sign-out") return jsonResponse({ success: true });
    if (url.pathname.startsWith("/api/v3")) return jsonResponse({ items: [] });
    if (url.pathname.endsWith("/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        "data: " +
          JSON.stringify({
            choices: [{ delta: { content: "Done." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 1, cost: 0.0001 },
          }) +
          "\n\ndata: [DONE]\n\n",
      );
      return;
    }
    jsonResponse({ error: "fixture: not found" }, 404);
  });
  await new Promise<void>((resolve) => providerServer!.listen(0, "127.0.0.1", resolve));
  providerOrigin = "http://127.0.0.1:" + (providerServer!.address() as { port: number }).port;

  // Enterprise layer that entitles the "admin" feature (required for hosted
  // workspace configuration to be trusted by the runtime).
  layer = mkdtempSync(join(tmpdir(), "omb-hosted-member-model-layer-"));
  mkdirSync(join(layer, "server"));
  writeFileSync(
    join(layer, "server/index.ts"),
    `import { createWorkspaceAccess as create } from ${JSON.stringify(pathToFileURL(join(ROOT, "enterprise/server/workspace-access.ts")).href)};
export function register() { return { customer: "Hosted member model fixture", features: ["admin"], expiresAt: null }; }
export function createWorkspaceAccess(options) {
  return create({ ...options, fetchImpl: async () => { throw new Error("Fixture must not contact a portal"); } });
}
`,
  );

  // Bootstrap using launchVerificationServer for the base env, then restart
  // the child with hosted-model + member sign-in env vars, reusing the same
  // data directory and port so the fixture URL stays stable.
  fixture = await launchVerificationServer({}, undefined, undefined, undefined, { dir: layer, licenseKey: "fixture-only" });
  child = fixture.child;

  await waitForExit(child, { signal: "SIGTERM" });

  const port = Number(new URL(fixture.info.url).port);
  const childEnv = verificationServerEnvironment({}, fixture.info.dataDir, port);
  Object.assign(childEnv, {
    OMB_ENTERPRISE_DIR: layer,
    OMB_LICENSE_KEY: "fixture-only",
    // Hosted workspace identity — must be HTTPS for hostedWorkspaceConfiguration.
    OMB_ADMIN_URL: "https://admin.example.test",
    OMB_ADMIN_WORKSPACE: "fixture",
    OMB_PUBLIC_URL: "https://fixture.example.test",
    OMB_ADMIN_MEMBERSHIP: "portal",
    // Model catalog and gateway token.
    OMB_HOSTED_MODELS: JSON.stringify(MODELS),
    OMB_HOSTED_MODEL_TOKEN: TOKEN,
    // CLIs for the hosted instances (fake CLIs from the test suite).
    OMB_HOSTED_CLAUDE_CLI: join(ROOT, "server/testing/fake-claude-cli.ts"),
    // Member account sign-in.
    NATION_ACCOUNT_SERVICE_URL: providerOrigin,
    OMB_SIGNIN_MEMBER_EMAILS: MEMBER,
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
        throw new Error(`Hosted member model fixture exited; see ${fixture!.info.logPath}`);
      }
      const response = await fetch(`${fixture!.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) });
      expect(response.status).toBe(200);
      expect((await response.json() as { pid?: number }).pid).toBe(child!.pid);
    },
    { timeout: 20_000, interval: 200 },
  );
}, 45_000);

afterAll(async () => {
  await waitForExit(child, { signal: "SIGTERM" });
  if (fixture) {
    const evidencePath = `${fixture.info.logPath}.hosted-member-bot-model.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath }));
    await fixture.close();
  }
  providerServer?.closeAllConnections();
  await new Promise<void>((resolve) => providerServer?.close(() => resolve()));
  if (layer) await removeTempDir(layer);
});

async function signIn(): Promise<string> {
  const start = await fetch(`${fixture!.info.url}/api/auth/email/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: MEMBER }),
    signal: AbortSignal.timeout(5_000),
  });
  expect(start.status, "email/start").toBe(200);
  const verify = await fetch(`${fixture!.info.url}/api/auth/email/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: MEMBER, code: "12345678", label: MEMBER }),
    signal: AbortSignal.timeout(5_000),
  });
  expect(verify.status, "email/verify").toBe(200);
  return String(verify.headers.get("set-cookie")).split(";")[0];
}

it("member can POST /api/bots with an assigned modelSelection and PATCH it later", async () => {
  const cookie = await signIn();

  // 1. Operator creates a bot first (loopback auth, no model selection).
  const created = await ownerRequest("/api/bots", { method: "POST", body: { name: "Scout" } });
  expect(created.status, "owner POST /api/bots").toBe(201);
  const botId: string = created.body.bot.id;

  // 2. Member can view the bot list.
  const list = await memberRequest(cookie, "/api/bots?messages=0");
  expect(list.status, "member GET /api/bots").toBe(200);
  expect(list.body.bots.some((b: any) => b.id === botId)).toBe(true);

  // 3. Member can POST /api/bots with an assigned model.
  const assigned = { instanceId: "claude", model: MODELS.anthropic[0] };
  const memberCreate = await memberRequest(cookie, "/api/bots", {
    method: "POST",
    body: { name: "Member bot", modelSelection: assigned },
  });
  expect(memberCreate.status, "member POST /api/bots with modelSelection").toBe(201);
  expect(memberCreate.body.bot.modelSelection).toMatchObject(assigned);
  const memberBotId: string = memberCreate.body.bot.id;

  // 4. Member POST with an unassigned model must still be rejected (400 from
  //    the catalog check, not 403 from the admin gate).
  const badModel = { instanceId: "claude", model: "claude-not-in-catalog" };
  const badCreate = await memberRequest(cookie, "/api/bots", {
    method: "POST",
    body: { name: "Bad model bot", modelSelection: badModel },
  });
  expect(badCreate.status, "member POST /api/bots with unassigned model").toBe(400);

  // 5. Member can PATCH a bot's modelSelection (bot-level default).
  const altModel = { instanceId: "claude", model: MODELS.anthropic[1] };
  const memberPatch = await memberRequest(cookie, `/api/bots/${memberBotId}`, {
    method: "PATCH",
    body: { modelSelection: altModel },
  });
  expect(memberPatch.status, "member PATCH /api/bots/:id modelSelection").toBe(200);
  expect(memberPatch.body.bot.modelSelection).toMatchObject(altModel);

  // 6. Member cannot change non-model fields via the bot patch endpoint.
  const forbiddenPatch = await memberRequest(cookie, `/api/bots/${memberBotId}`, {
    method: "PATCH",
    body: { modelSelection: assigned, cwd: "/tmp" },
  });
  expect(forbiddenPatch.status, "member PATCH /api/bots/:id with cwd (forbidden)").toBe(403);

  // 7. Member can PATCH a task's modelSelection.
  const taskPatch = await memberRequest(cookie, `/api/bots/${memberBotId}/tasks/${memberCreate.body.bot.threadId}`, {
    method: "PATCH",
    body: { modelSelection: assigned },
  });
  expect(taskPatch.status, "member PATCH task modelSelection").toBe(200);

  // 8. Provider-key / instance mutations remain forbidden for members.
  for (const [method, path, body] of [
    ["PATCH", "/api/instances/claude", { cli: "forbidden-cli" }],
    ["PUT", "/api/config", { anthropic: { key: "forbidden-key" } }],
    ["POST", "/api/instances/claude-accounts", { displayName: "Forbidden account" }],
  ] as const) {
    const denied = await memberRequest(cookie, path, { method, body });
    expect(denied.status, `member ${method} ${path} (must be 403)`).toBe(403);
  }

  // 9. GET /api/instances for a member now returns the real hosted catalog
  //    (read-only, no CLI or auth info).
  const instances = await memberRequest(cookie, "/api/instances");
  expect(instances.status, "member GET /api/instances").toBe(200);
  const catalog = instances.body.instances as Array<{ instanceId: string; readOnly?: boolean; models: { options: Array<{ id: string }> } }>;
  const claudeInstance = catalog.find((i) => i.instanceId === "claude");
  expect(claudeInstance, "hosted Claude instance in member catalog").toBeTruthy();
  expect(claudeInstance!.readOnly).toBe(true);
  expect(claudeInstance!.models.options.map((o) => o.id)).toEqual(MODELS.anthropic);
  // Token must never appear in any response.
  expect(JSON.stringify(instances.body)).not.toContain(TOKEN);

  // 10. GET /api/config for a member advertises hostedModelSelection: true.
  const config = await memberRequest(cookie, "/api/config");
  expect(config.status, "member GET /api/config").toBe(200);
  expect(config.body.hostedModelSelection, "hostedModelSelection in member config").toBe(true);
  expect(config.body.isProductOwner, "isProductOwner remains false").toBe(false);
}, 30_000);
