import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { createWorkspacePreferencesRoutes, type WorkspacePreferences } from "./workspace-preferences.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))); });

const member: RequestAuth = { kind: "session", via: "cookie", scopes: ["client"], session: { id: "s", tokenHash: "0".repeat(64), label: "Browser", scopes: ["client"], createdAt: 0, lastSeenAt: 0, expiresAt: Date.now() + 1e9, email: "alice@example.test", userId: "usr_1" } };
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

async function serve(auth: RequestAuth, personalWorkspace: boolean) {
  const saved: Array<{ patch: WorkspacePreferences; admin: boolean }> = [];
  const route = createWorkspacePreferencesRoutes({ personalWorkspace, save: (patch, admin) => { saved.push({ patch, admin }); return { saved: patch }; } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
    } catch (error) { json(res, (error as { status?: number }).status ?? 500, { error: String(error) }); }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const patch = async (body: unknown) => {
    const response = await fetch(`${base}/api/workspace/preferences`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { patch, saved };
}

describe("workspace preferences", () => {
  it("let the member of their own workspace save first-run progress, language and name", async () => {
    const { patch, saved } = await serve(member, true);
    const body = { onboarding: { completedAt: "2026-09-26T12:00:00.000Z", version: 1, hintsSeen: ["composer"] }, language: "fr", profile: { name: "Alice" } };
    expect(await patch(body)).toEqual({ status: 200, body: { saved: body } });
    expect(saved).toEqual([{ patch: body, admin: false }]);
  });

  it("refuse a member of a shared desk, whose preferences are its owner's", async () => {
    const { patch, saved } = await serve(member, false);
    expect((await patch({ language: "fr" })).status).toBe(403);
    expect(saved).toEqual([]);
  });

  it("let an admin save them anywhere", async () => {
    const { patch, saved } = await serve(owner, false);
    expect((await patch({ onboarding: { reelSeen: true } })).status).toBe(200);
    expect(saved[0]?.admin).toBe(true);
  });

  it("accept nothing but those three settings", async () => {
    const { patch, saved } = await serve(member, true);
    for (const body of [
      { signIn: { admins: ["mallory@example.test"] } },
      { instances: { claude: { driver: "claudeAgent" } } },
      { features: { browser: true } },
      { profile: { name: "A", email: "x@example.test" } },
      { onboarding: { completedAt: "now", extra: 1 } },
      {},
    ]) {
      expect((await patch(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(saved).toEqual([]);
  });
});
