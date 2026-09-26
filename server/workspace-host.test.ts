// The workspace host: what a workspace server inherits, what crosses the
// forwarding boundary in each direction, and its lifecycle (one start for
// concurrent callers, streaming, idle stop, crash recovery) against a
// stand-in server.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  forwardedRequestHeaders,
  returnedResponseHeaders,
  workspaceConfig,
  workspaceServerEnvironment,
  WorkspaceHost,
} from "./workspace-host.ts";
import type { WorkspaceRef } from "./accounts.ts";

const FAKE = fileURLToPath(new URL("./testing/fake-workspace-server.ts", import.meta.url));
const REF: WorkspaceRef = { id: "ws_AAAAAAAAAAAAAAAAAAAAAA", userId: "usr_1", email: "alice@example.test" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe("what a workspace server inherits", () => {
  const parent: NodeJS.ProcessEnv = {
    PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-nation", NATION_MODEL_FAST: "fast/model", NATION_TREASURY_ROBINHOOD: "0xabc",
    COMPOSIO_API_KEY: "ak_x", NATION_PUBLIC_NAME: "Nation Team Chat",
    // never
    NATION_DATA_DIR: "/root/.nationteamchat", OMB_DATA_DIR: "/root/.nationteamchat", NATION_PRODUCT_OWNER: "1", NATION_PRODUCT_ADMIN: "1",
    OMB_SIGNIN_EMAILS: "founder@example.test", OMB_SIGNIN_MEMBER_EMAILS: "cos@example.test", NATION_ACCOUNT_SERVICE_URL: "https://accounts",
    OMB_CONTROL_PLANE_URL: "https://cp", NATION_SMTP_URL: "smtps://u:p@smtp", NATION_MAIL_FROM: "x", NATION_MAIL_OUTBOX: "1",
    NATION_ADMIN_PIN: "1234", NATION_MEMBER_HOST_ENGINES: "1", NATION_WEB_READER_ALLOW_LOOPBACK: "1", OMB_BOX_API: "https://box",
    CONTAINER_HOST: "ssh://root@vps", CONTAINER_SSHKEY: "/root/.ssh/id", OMB_PUBLIC_URL: "https://thenation.city/swarm",
    NATION_TRUSTED_ORIGINS: "https://thenation.city", OMB_HOSTED_MODEL_TOKEN: "omb_workspace_x", NATION_ACCOUNTS: "1",
    TURNKEY_API_PRIVATE_KEY: "secret", ANTHROPIC_API_KEY: "sk-ant", OPENMAUSBOT_INTERNAL_DATA_DIR_LEASE: "lease",
  };
  const env = workspaceServerEnvironment(parent, { root: "/data/workspaces/ws_x", port: 41000, workspaceId: REF.id, key: "k".repeat(43), creditsDb: "/data/nation-credits.db", brandFile: "/data/brand.json" });

  it("gets its own data directory and home, and the shared ledger", () => {
    expect(env).toMatchObject({
      HOME: "/data/workspaces/ws_x", NATION_DATA_DIR: "/data/workspaces/ws_x", OMB_DATA_DIR: "/data/workspaces/ws_x",
      OMB_PORT: "41000", OMB_WEBHOOK_PORT: "41001", NATION_CREDITS_DB: "/data/nation-credits.db", NATION_CREDIT_WATCHER: "0",
      NATION_WORKSPACE_ID: REF.id, NATION_BRAND_FILE: "/data/brand.json", NATION_TRUST_PROXY: "1",
    });
  });

  it("is never the product owner", () => {
    expect(env.NATION_PRODUCT_OWNER).toBe("0");
    expect(env.NATION_PRODUCT_ADMIN).toBe("0");
  });

  it("keeps model, credit and connected-app settings, and nothing else", () => {
    expect(env).toMatchObject({ PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-nation", NATION_MODEL_FAST: "fast/model", NATION_TREASURY_ROBINHOOD: "0xabc", COMPOSIO_API_KEY: "ak_x" });
    for (const name of ["OMB_SIGNIN_EMAILS", "OMB_SIGNIN_MEMBER_EMAILS", "NATION_ACCOUNT_SERVICE_URL", "OMB_CONTROL_PLANE_URL", "NATION_SMTP_URL",
      "NATION_MAIL_FROM", "NATION_MAIL_OUTBOX", "NATION_ADMIN_PIN", "NATION_MEMBER_HOST_ENGINES", "NATION_WEB_READER_ALLOW_LOOPBACK", "OMB_BOX_API",
      "CONTAINER_HOST", "CONTAINER_SSHKEY", "OMB_PUBLIC_URL", "NATION_TRUSTED_ORIGINS", "OMB_HOSTED_MODEL_TOKEN", "NATION_ACCOUNTS",
      "TURNKEY_API_PRIVATE_KEY", "ANTHROPIC_API_KEY", "OPENMAUSBOT_INTERNAL_DATA_DIR_LEASE"]) {
      expect(env[name], name).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain("/root/");
  });
});

describe("a workspace's own config", () => {
  it("allows only its account, runs NATION API only, and drops every desk and key", () => {
    const next = workspaceConfig({
      profile: { name: "Alice" }, onboarding: { completedAt: "2026-09-26T00:00:00Z", version: 1 },
      signIn: { admins: ["mallory@example.test"], members: ["mallory@example.test"] },
      instances: { claude: { driver: "claudeAgent" } }, defaultModelSelection: { instanceId: "claude", model: "x" },
      box: { token: "t" }, vps: { sshAlias: "a" }, localVm: { mode: "shared" }, anthropic: { key: "k" }, composio: { apiKey: "k" },
      features: { browser: true, computers: true, sharedComputers: true, showToolCalls: true },
    }, "alice@example.test", { modelRouting: { enabled: true } });
    expect(next).toEqual({
      profile: { name: "Alice" }, onboarding: { completedAt: "2026-09-26T00:00:00Z", version: 1 },
      signIn: { admins: [], members: ["alice@example.test"] },
      instances: { nationApi: { driver: "nation-openrouter", displayName: "NATION API" } },
      features: { browser: false, computers: false, sharedComputers: false, showToolCalls: true },
      modelRouting: { enabled: true },
    });
  });

  it("keeps a NATION API model choice and follows the founder's settings when they change", () => {
    const first = workspaceConfig({ defaultModelSelection: { instanceId: "nationApi", model: "moonshotai/kimi-k2" } }, "a@example.test", { webSearch: { provider: "brave" } });
    expect(first.defaultModelSelection).toEqual({ instanceId: "nationApi", model: "moonshotai/kimi-k2" });
    expect(first.webSearch).toEqual({ provider: "brave" });
    expect(workspaceConfig(first, "a@example.test", {}).webSearch).toBeUndefined();
  });
});

describe("the forwarding boundary", () => {
  it("sends the workspace bearer and the caller's address, never the browser's credentials or proxy claims", () => {
    const out = forwardedRequestHeaders({
      host: "thenation.city", origin: "https://thenation.city", referer: "https://thenation.city/swarm/",
      cookie: "nation_account=nas_x; omb_session_8799_abc=omb_sess_founder; nation_device=11111111-2222-4333-8444-555555555555",
      authorization: "Bearer omb_sess_forged", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "https", forwarded: "for=127.0.0.1",
      "x-real-ip": "127.0.0.1", "x-openmausbot-desktop-owner": "1", "x-nation-workspace-key": "forged", connection: "keep-alive",
      "content-type": "application/json", "content-length": "12", accept: "text/event-stream", "user-agent": "Safari",
    }, { token: "omb_sess_workspace", port: 41000, clientIp: "203.0.113.9" });
    expect(out).toEqual({
      "content-type": "application/json", "content-length": "12", accept: "text/event-stream", "user-agent": "Safari",
      cookie: "nation_device=11111111-2222-4333-8444-555555555555",
      authorization: "Bearer omb_sess_workspace", host: "127.0.0.1:41000", "x-real-ip": "203.0.113.9",
    });
  });

  it("returns no cookie but the device id", () => {
    expect(returnedResponseHeaders({
      "content-type": "application/json", "set-cookie": ["nation_device=abc; Path=/", "omb_session_1=x; Path=/"], connection: "close",
    })).toEqual({ "content-type": "application/json", "set-cookie": ["nation_device=abc; Path=/"] });
    expect(returnedResponseHeaders({ "set-cookie": ["omb_session_1=x"] })["set-cookie"]).toBeUndefined();
  });
});

describe("workspace lifecycle", () => {
  async function setup(options: { idleMs?: number; maxRunning?: number } = {}) {
    const dataDir = mkdtempSync(join(tmpdir(), "nation-host-"));
    const lines: string[] = [];
    const host = new WorkspaceHost({
      dataDir, creditsDb: join(dataDir, "nation-credits.db"), env: { PATH: process.env.PATH },
      command: { file: process.execPath, args: ["--experimental-strip-types", "--no-warnings", FAKE] },
      idleMs: options.idleMs ?? 60_000, maxRunning: options.maxRunning, startTimeoutMs: 15_000, log: (line) => lines.push(line),
    });
    const front: Server = createServer((req, res) => {
      const ref = req.headers["x-test-workspace"] === "b" ? { ...REF, id: "ws_BBBBBBBBBBBBBBBBBBBBBB", email: "bob@example.test" } : REF;
      void host.forward(req, res, ref, "203.0.113.9");
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(front.address() as { port: number }).port}`;
    cleanups.push(async () => {
      await host.close();
      await new Promise((resolve) => front.close(resolve));
      rmSync(dataDir, { recursive: true, force: true });
    });
    return { host, base, dataDir, lines };
  }

  it("starts once for concurrent requests and forwards through the boundary", async () => {
    const { host, base } = await setup();
    const [a, b] = await Promise.all([host.ensure(REF), host.ensure(REF)]);
    expect(a.port).toBe(b.port);
    const response = await fetch(`${base}/api/echo`, { headers: { cookie: "nation_account=nas_x; nation_device=11111111-2222-4333-8444-555555555555", origin: "https://thenation.city" } });
    const echo = await response.json() as any;
    expect(echo.minted).toBe(1);
    expect(echo.headers.authorization).toBe(`Bearer ${a.token}`);
    expect(echo.headers.cookie).toBe("nation_device=11111111-2222-4333-8444-555555555555");
    expect(echo.headers["x-real-ip"]).toBe("203.0.113.9");
    expect(echo.headers.origin).toBeUndefined();
    expect(echo.env).toMatchObject({ owner: "0", watcher: "0" });
    expect(echo.env.dataDir).toBe(host.rootOf(REF.id));
    expect(response.headers.getSetCookie()).toEqual(["nation_device=11111111-2222-4333-8444-555555555555; Path=/"]);
  });

  it("streams events as they happen and lets go when the browser leaves", async () => {
    const { host, base } = await setup();
    const controller = new AbortController();
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    while ((text.match(/ping/g) ?? []).length < 3) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    await expect.poll(() => (host as any).running.get(REF.id)?.inflight, { timeout: 5_000 }).toBe(0);
  });

  it("stops an idle workspace, but not a busy one or one a routine keeps awake", async () => {
    const { host, base } = await setup({ idleMs: 1 });
    await fetch(`${base}/api/echo`);
    const root = host.rootOf(REF.id);
    writeFileSync(join(root, "fake-state.json"), JSON.stringify({ busy: true }));
    await host.sweep(Date.now() + 10_000);
    expect(host.isRunning(REF.id)).toBe(true);
    writeFileSync(join(root, "fake-state.json"), JSON.stringify({ keepAlive: true }));
    await host.sweep(Date.now() + 10_000);
    expect(host.isRunning(REF.id)).toBe(true);
    writeFileSync(join(root, "fake-state.json"), JSON.stringify({}));
    await host.sweep(Date.now() + 10_000);
    expect(host.isRunning(REF.id)).toBe(false);
    // …and it comes back on the next request.
    expect((await fetch(`${base}/api/echo`)).status).toBe(200);
    expect(host.isRunning(REF.id)).toBe(true);
  });

  it("makes room by stopping the least recently used idle workspace", async () => {
    const { host, base } = await setup({ maxRunning: 1 });
    await fetch(`${base}/api/echo`);
    expect((await fetch(`${base}/api/echo`, { headers: { "x-test-workspace": "b" } })).status).toBe(200);
    expect(host.runningCount()).toBe(1);
    expect(host.isRunning(REF.id)).toBe(false);
  });

  it("answers busy when every running workspace is working", async () => {
    const { host, base } = await setup({ maxRunning: 1 });
    await fetch(`${base}/api/echo`);
    writeFileSync(join(host.rootOf(REF.id), "fake-state.json"), JSON.stringify({ busy: true }));
    const refused = await fetch(`${base}/api/echo`, { headers: { "x-test-workspace": "b" } });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: "Nation Team Chat is busy right now. Try again in a minute." });
    expect(host.isRunning(REF.id)).toBe(true);
  });

  it("starts again after a crash", async () => {
    const { host, base, lines } = await setup();
    const first = await host.ensure(REF);
    await fetch(`${base}/api/exit`);
    await expect.poll(() => host.isRunning(REF.id), { timeout: 5_000 }).toBe(false);
    expect(lines.join("\n")).toMatch(/stopped unexpectedly/);
    expect((await fetch(`${base}/api/echo`)).status).toBe(200);
    expect((await host.ensure(REF)).port).not.toBe(first.port);
  });

  it("never shows the browser a sign-in error for its own refused credential", async () => {
    const { host, base } = await setup();
    await fetch(`${base}/api/echo`);
    await fetch(`${base}/api/revoke`);
    const refused = await fetch(`${base}/api/echo`);
    expect(refused.status).toBe(503);
    await expect.poll(async () => (await fetch(`${base}/api/echo`)).status, { timeout: 5_000 }).toBe(200);
    expect(host.isRunning(REF.id)).toBe(true);
  });
});
