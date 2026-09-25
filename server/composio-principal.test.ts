// Per-account connector identity for hosted NATION: one backend project key,
// one Composio user and Session per NATION account, and no broker fallback.
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  authorizeService,
  configured,
  connectedServices,
  connectionMode,
  connectionStatus,
  principalUserId,
  relayMcp,
  removeAccount,
  setManagedBrokerAccess,
  setPrincipalSessionFile,
} from "./composio.ts";

let api: Server;
let origin = "";
/** Composio's truth: which user id owns which connected account. */
const accounts = [
  { id: "ca_alice_gmail", user: "", toolkit: "gmail", status: "ACTIVE" },
  { id: "ca_bob_github", user: "", toolkit: "github", status: "ACTIVE" },
];
const sessions = new Map<string, string>(); // session id -> user id
const mcpCalls: Array<{ session: string; user: string }> = [];
const alice = { accountId: "email:alice-fixture" };
const bob = { accountId: "email:bob-fixture" };

beforeAll(async () => {
  accounts[0].user = principalUserId(alice);
  accounts[1].user = principalUserId(bob);
  api = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers["x-api-key"] !== "ak_principal_fixture") return json({ error: "bad key" }, 401);
    if (url.pathname === "/api/v3.1/auth_configs") return json({ items: [] });
    if (url.pathname === "/api/v3.1/tool_router/session" && req.method === "POST") {
      const id = `trs_${sessions.size + 1}`;
      sessions.set(id, body.user_id);
      return json({ session_id: id, mcp: { type: "http", url: `${origin}/mcp/${id}` }, config: { user_id: body.user_id, multi_account: { enable: true } } });
    }
    let m = url.pathname.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)$/);
    if (m) {
      const user = sessions.get(m[1]);
      return user ? json({ session_id: m[1], mcp: { type: "http", url: `${origin}/mcp/${m[1]}` }, config: { user_id: user, multi_account: { enable: true } } }) : json({}, 404);
    }
    m = url.pathname.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)\/toolkits$/);
    if (m) {
      const user = sessions.get(m[1]);
      return json({ items: accounts.filter((a) => a.user === user).map((a) => ({ slug: a.toolkit, connected_account: { id: a.id, status: a.status } })) });
    }
    m = url.pathname.match(/^\/api\/v3\.1\/tool_router\/session\/([\w-]+)\/link$/);
    if (m) return json({ redirect_url: `${origin}/oauth/${sessions.get(m[1])}/${body.toolkit}` });
    if (url.pathname === "/api/v3.1/connected_accounts") {
      const user = url.searchParams.get("user_ids");
      return json({ items: accounts.filter((a) => a.user === user).map((a) => ({ id: a.id, status: a.status, toolkit: { slug: a.toolkit } })) });
    }
    m = url.pathname.match(/^\/api\/v3\.1\/connected_accounts\/([\w-]+)$/);
    if (m && req.method === "DELETE") { const i = accounts.findIndex((a) => a.id === m![1]); if (i >= 0) accounts.splice(i, 1); return json({}); }
    m = url.pathname.match(/^\/mcp\/([\w-]+)$/);
    if (m) { mcpCalls.push({ session: m[1], user: sessions.get(m[1]) ?? "" }); return json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }); }
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  process.env.OMB_COMPOSIO_API = `${origin}/api/v3.1`;
  process.env.OMB_COMPOSIO_TOOLKITS_API = `${origin}/api/v3`;
});

afterAll(async () => {
  delete process.env.OMB_COMPOSIO_API;
  delete process.env.OMB_COMPOSIO_TOOLKITS_API;
  setManagedBrokerAccess(null);
  await new Promise<void>((resolve) => api.close(() => resolve()));
});

beforeEach(() => setPrincipalSessionFile(join(mkdtempSync(join(tmpdir(), "nation-principal-")), "sessions.json")));

const cfg = (): AppConfig => ({ composio: { apiKey: "ak_principal_fixture" } } as AppConfig);

it("derives a stable, non-identifying Composio user per NATION account", () => {
  expect(principalUserId(alice)).toBe(principalUserId({ ...alice }));
  expect(principalUserId(alice)).not.toBe(principalUserId(bob));
  expect(principalUserId(alice)).toMatch(/^nation_[0-9a-f]{40}$/);
  expect(principalUserId(alice)).not.toContain("alice");
});

it("shows each member only their own connections and never the installation's", async () => {
  const mine = await connectedServices(cfg(), alice);
  const theirs = await connectedServices(cfg(), bob);
  expect(Object.keys(mine)).toEqual(["gmail"]);
  expect(Object.keys(theirs)).toEqual(["github"]);
  expect((await connectionStatus(cfg(), ["gmail", "github"], bob)).gmail?.connected).toBe(false);
  expect((await connectionStatus(cfg(), ["gmail", "github"], bob)).github?.connected).toBe(true);
});

it("mints the OAuth link inside the requesting member's own Session", async () => {
  const link = await authorizeService(cfg(), "notion", undefined, bob);
  expect(link.url).toBe(`${origin}/oauth/${principalUserId(bob)}/notion`);
});

it("relays MCP calls through the caller's Session only", async () => {
  mcpCalls.length = 0;
  await relayMcp(cfg(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, undefined, alice);
  await relayMcp(cfg(), { jsonrpc: "2.0", id: 2, method: "tools/list" }, undefined, bob);
  expect(mcpCalls.map((call) => call.user)).toEqual([principalUserId(alice), principalUserId(bob)]);
});

it("refuses to disconnect another member's account", async () => {
  expect(await removeAccount(cfg(), "gmail", "ca_alice_gmail", bob)).toEqual({ removed: 0 });
  expect(accounts.some((account) => account.id === "ca_alice_gmail")).toBe(true);
});

it("persists only non-secret Session ids, keyed by the derived user", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "nation-principal-")), "sessions.json");
  setPrincipalSessionFile(file);
  await connectedServices(cfg(), alice);
  const saved = readFileSync(file, "utf8");
  expect(Object.keys(JSON.parse(saved))).toEqual([principalUserId(alice)]);
  expect(saved).not.toContain("ak_principal_fixture");
});

it("never hands the single-installation broker to a member", async () => {
  setManagedBrokerAccess({ url: `${origin}/broker`, token: "a".repeat(64) });
  const brokerOnly = { composio: {} } as AppConfig;
  expect(connectionMode(brokerOnly)).toBe("managed");
  expect(connectionMode(brokerOnly, alice)).toBe("unavailable");
  expect(configured(brokerOnly, alice)).toBe(false);
  await expect(connectedServices(brokerOnly, alice)).rejects.toThrow(/unavailable/);
  setManagedBrokerAccess(null);
});
