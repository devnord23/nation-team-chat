import { describe, expect, it } from "vitest";
import { CONNECTORS_ENABLED } from "./connector-policy.ts";
import { launchVerificationServer } from "../scripts/control-omb.ts";

describe("connected-app access", () => {
  it("restores owner APIs while refusing unauthenticated and member management", async () => {
    expect(CONNECTORS_ENABLED).toBe(true);
    const fixture = await launchVerificationServer(process.env);
    const call = async (path: string, method = "GET", body?: unknown, token?: string) =>
      fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      for (const path of ["/api/connectors/catalog", "/api/connectors/connected", "/api/mcp/servers"]) {
        expect((await call(path)).status).toBe(200);
        expect((await call(path, "GET", undefined, "omb_sess_invalid")).status).toBe(401);
      }
      const pairing: any = await (await call("/api/auth/pairing", "POST", { scopes: ["client"], label: "Connector fixture" })).json();
      const member: any = await (await call("/api/pair", "POST", { code: pairing.code, deviceName: "Connector fixture" })).json();
      for (const [path, method, body] of [
        ["/api/connectors/catalog", "GET", undefined],
        ["/api/connectors/connected", "GET", undefined],
        ["/api/connectors/gmail/authorize", "POST", {}],
        ["/api/mcp/servers", "POST", { name: "untrusted" }],
        ["/api/config", "PUT", { composio: { apiKey: "untrusted" }, box: { token: "untrusted" } }],
      ] as const) expect((await call(path, method, body, member.token)).status, path).toBe(403);
    } finally { await fixture.close(); }
  }, 30_000);
});
