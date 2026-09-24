import { describe, expect, it } from "vitest";
import { CONNECTORS_ENABLED, removedConnectorPath } from "./connector-policy.ts";
import { launchVerificationServer } from "../scripts/control-omb.ts";

describe("removed connector surfaces", () => {
  it("does not disable built-in desks, chat or team tools", () => {
    expect(CONNECTORS_ENABLED).toBe(false);
    for (const path of ["/api/bots", "/api/groups", "/api/internal/agents/mcp", "/api/internal/browser/mcp", "/api/shared-computers/connect"]) {
      expect(removedConnectorPath(path), path).toBe(false);
    }
  });
  it("returns 404 before authorization for every removed route and HTTP method", async () => {
    const fixture = await launchVerificationServer(process.env);
    try {
      for (const path of ["/api/connectors", "/api/connectors/gmail/authorize", "/api/internal/connectors/mcp", "/api/internal/connectors/request", "/api/mcp/servers", "/api/integrations", "/api/marketplace", "/api/bots/example/slack-management", "/swarm/connectors"]) {
        for (const method of ["GET", "POST", "PUT", "DELETE"]) {
          const response = await fetch(fixture.info.url + path, { method, headers: { authorization: "Bearer invalid" } });
          expect(response.status, `${method} ${path}`).toBe(404);
        }
      }
    } finally { await fixture.close(); }
  }, 30_000);
});
