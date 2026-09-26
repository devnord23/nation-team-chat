import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceEndpoint, type WorkspaceEndpointDeps } from "./workspace-endpoint.ts";
import { WORKSPACE_ACTIVITY_PATH, WORKSPACE_KEY_HEADER, WORKSPACE_SESSION_PATH } from "./workspace-host.ts";

const KEY = "k".repeat(43);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))); });

async function setup(deps: Partial<WorkspaceEndpointDeps> = {}) {
  const issued: Array<{ userId: string; email: string }> = [];
  const endpoint = createWorkspaceEndpoint({
    key: KEY,
    ownAccount: (email) => email === "alice@example.test",
    replaceSession: (account) => { issued.push(account); return `omb_sess_${issued.length}`; },
    activity: () => ({ busy: true, keepAlive: false }),
    ...deps,
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (await endpoint(req, res, url.pathname, req.method ?? "GET")) return;
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ from: "sign-in gate" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (path: string, init: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(base + path, {
      method: init.body === undefined ? "GET" : "POST",
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as any, cache: response.headers.get("cache-control") };
  };
  return { call, issued };
}

const key = (value = KEY) => ({ [WORKSPACE_KEY_HEADER]: value });

describe("the workspace server's host routes", () => {
  it("mint a client session for this workspace's own account only", async () => {
    const { call, issued } = await setup();
    expect(await call(WORKSPACE_SESSION_PATH, { body: { email: " Alice@Example.test ", userId: "usr_1" }, headers: key() }))
      .toEqual({ status: 200, body: { token: "omb_sess_1" }, cache: "no-store" });
    expect(issued).toEqual([{ userId: "usr_1", email: "alice@example.test" }]);
    expect((await call(WORKSPACE_SESSION_PATH, { body: { email: "bob@example.test", userId: "usr_2" }, headers: key() })).status).toBe(403);
    expect((await call(WORKSPACE_SESSION_PATH, { body: { email: "alice@example.test" }, headers: key() })).status).toBe(400);
    expect(issued).toHaveLength(1);
  });

  it("tell the host whether a turn or an enabled routine should keep it running", async () => {
    const { call } = await setup({ activity: () => ({ busy: false, keepAlive: true }) });
    expect(await call(WORKSPACE_ACTIVITY_PATH, { headers: key() })).toEqual({ status: 200, body: { busy: false, keepAlive: true }, cache: "no-store" });
  });

  it("refuse a wrong or missing key and a request that came through a proxy", async () => {
    const { call, issued } = await setup();
    const body = { email: "alice@example.test", userId: "usr_1" };
    expect((await call(WORKSPACE_SESSION_PATH, { body })).status).toBe(403);
    expect((await call(WORKSPACE_SESSION_PATH, { body, headers: key("x".repeat(43)) })).status).toBe(403);
    expect((await call(WORKSPACE_SESSION_PATH, { body, headers: key(KEY.slice(1)) })).status).toBe(403);
    expect((await call(WORKSPACE_SESSION_PATH, { body, headers: { ...key(), "x-forwarded-for": "203.0.113.7" } })).status).toBe(403);
    expect((await call(WORKSPACE_ACTIVITY_PATH, { headers: { ...key(), "x-forwarded-host": "thenation.city" } })).status).toBe(403);
    expect(issued).toEqual([]);
  });

  it("refuse everyone when the server was started without a long enough key", async () => {
    for (const configured of [undefined, "", "short"]) {
      const { call, issued } = await setup({ key: configured });
      expect((await call(WORKSPACE_SESSION_PATH, { body: { email: "alice@example.test", userId: "usr_1" }, headers: key(configured ?? "") })).status).toBe(403);
      expect(issued).toEqual([]);
    }
  });

  it("leave every other request to the rest of the server", async () => {
    const { call } = await setup();
    expect(await call("/api/bots", { headers: key() })).toMatchObject({ status: 401, body: { from: "sign-in gate" } });
    expect((await call(WORKSPACE_SESSION_PATH, { headers: key() })).status).toBe(404);
  });
});
