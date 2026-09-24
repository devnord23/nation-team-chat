// Connected-app authorization on a single-user (self-hosted) install, over
// real HTTP. The install's connected accounts belong to its owner: admin and
// trusted loopback may manage them; a paired client-scope device may only
// poll a connection card's status (as upstream allowed) and may never manage
// the install's accounts or its connector configuration.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { CONNECTORS_ENABLED } from "./connector-policy.ts";
import { launchVerificationServer } from "../scripts/control-omb.ts";

const TEST_CAPABILITY = "connector-policy-test-capability-key";

describe("connected-app access", () => {
  it("lets the owner manage install connectors, paired clients only poll card status", async () => {
    expect(CONNECTORS_ENABLED).toBe(true);
    // Loopback stand-in for the managed connection service (one install identity).
    const brokerCalls: Array<{ method: string; path: string }> = [];
    const broker = createServer((req, res) => {
      const path = new URL(req.url!, "http://fixture").pathname;
      brokerCalls.push({ method: req.method ?? "GET", path });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer " + "a".repeat(64)) { res.statusCode = 401; res.end("{}"); return; }
      if (path.endsWith("/authorize")) return res.end(JSON.stringify({ url: "https://connect.composio.dev/link/fixture" }));
      if (req.method === "DELETE") return res.end(JSON.stringify({ removed: 1 }));
      if (path === "/broker/v1/connectors") return res.end(JSON.stringify({ services: { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "ca_owner", status: "ACTIVE" }] } } }));
      if (path === "/broker/v1/connectors/connected") return res.end(JSON.stringify({ services: { gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "ca_owner", status: "ACTIVE" }] } } }));
      return res.end(JSON.stringify({ items: [] }));
    });
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + (broker.address() as { port: number }).port;
    const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
      undefined, origin, undefined, TEST_CAPABILITY);
    const call = async (path: string, method = "GET", body?: unknown, token?: string, extra: Record<string, string> = {}) =>
      fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const mutations = () => brokerCalls.filter((item) => item.method !== "GET").length;
    try {
      // Owner (trusted loopback): full install-level management.
      for (const path of ["/api/connectors/catalog", "/api/connectors/connected", "/api/connectors?services=gmail", "/api/mcp/servers"]) {
        expect((await call(path)).status, path).toBe(200);
        expect((await call(path, "GET", undefined, "omb_sess_invalid")).status, path).toBe(401);
      }
      expect((await call("/api/connectors/catalog").then((r) => r.json()) as any).configured).toBe(true);
      expect((await call("/api/connectors/gmail/authorize", "POST", {})).status).toBe(200);
      expect((await call("/api/connectors/gmail/accounts/ca_owner", "DELETE")).status).toBe(200);
      const ownerMutations = mutations();
      expect(ownerMutations).toBe(2);

      // A real connection card, filed through the normal connection-request path.
      const { bot } = await (await call("/api/bots", "POST", { name: "Policy fixture" })).json() as any;
      const capability = await (await call("/api/testing/internal-capability", "POST", { botId: bot.id, threadId: bot.threadId, kind: "connectors" },
        undefined, { "x-openmausbot-test-capability": TEST_CAPABILITY })).json() as any;
      const filed = await call("/api/internal/connectors/request", "POST",
        { botId: bot.id, threadId: bot.threadId, resumeKey: "policy-resume-1", items: [{ slug: "gmail" }] }, capability.token);
      expect(filed.status, await filed.clone().text()).toBe(200);
      const [cardId] = (await filed.json() as any).messageIds;

      // Paired client-scope device.
      const pairing: any = await (await call("/api/auth/pairing", "POST", { scopes: ["client"], label: "Connector fixture" })).json();
      const member: any = await (await call("/api/pair", "POST", { code: pairing.code, deviceName: "Connector fixture" })).json();
      // allowed: poll the card's status, as upstream did
      const status = await call(`/api/bots/${bot.id}/connector-cards/${cardId}/status?threadId=${bot.threadId}`, "GET", undefined, member.token);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ connected: true });
      // refused: reading or managing the install's accounts and configuration
      for (const [path, method, body] of [
        ["/api/connectors/catalog", "GET", undefined],
        ["/api/connectors/connected", "GET", undefined],
        ["/api/connectors?services=gmail", "GET", undefined],
        ["/api/connectors/gmail/authorize", "POST", {}],
        ["/api/connectors/gmail", "DELETE", undefined],
        ["/api/connectors/gmail/accounts/ca_owner", "DELETE", undefined],
        [`/api/bots/${bot.id}/connector-cards/${cardId}/authorize`, "POST", { threadId: bot.threadId }],
        ["/api/mcp/servers", "GET", undefined],
        ["/api/mcp/servers", "POST", { name: "untrusted" }],
        [`/api/bots/${bot.id}`, "PATCH", { composio: true }],
        ["/api/config", "PUT", { composio: { apiKey: "untrusted" }, box: { token: "untrusted" } }],
        ["/api/config", "PATCH", { composio: { apiKey: "untrusted" } }],
      ] as const) expect((await call(path, method, body, member.token)).status, `${method} ${path}`).toBe(403);
      // none of the refused calls reached the connection service
      expect(mutations()).toBe(ownerMutations);
      // and the member's config view carries no connector configuration detail
      const memberConfig = await (await call("/api/config", "GET", undefined, member.token)).json() as any;
      expect(memberConfig.isProductOwner).toBe(false);
      expect(JSON.stringify(memberConfig)).not.toMatch(/apiKey|broker|self-hosted|managed|composio\.dev/i);
    } finally {
      await fixture.close();
      broker.closeAllConnections();
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    }
  }, 60_000);
});
