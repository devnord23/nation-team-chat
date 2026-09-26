// The Settings desk inventories must answer 200 whatever the provider does:
// a proxy in front of the server turns a slow or failed read into a bare 502,
// which is what the owner saw as "VPS inventory request failed (502)".
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagedBoxInventory } from "../box.ts";
import { json, readBody, setResponseOwner } from "../harness/http.ts";
import type { ManagedVpsInventory } from "../vps-computer.ts";
import {
  DESK_KEY_REJECTED,
  DESKS_SLOW,
  DESKS_UNREACHABLE,
  createComputerInventoryRoutes,
  type ComputerInventoryRouteDeps,
} from "./computer-inventory.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

/** Serves the route as handleRequest does: an admin session's response is
 * marked as the owner's (server/index.ts), which keeps owner-only fields. */
async function serve(deps: ComputerInventoryRouteDeps, owner = true): Promise<string> {
  const route = createComputerInventoryRoutes(deps);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    setResponseOwner(res, owner);
    const handled = await dispatchRoutes([route], {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const healthyVps: ManagedVpsInventory = {
  configured: true,
  available: true,
  sshAlias: "nation-vps",
  problem: null,
  instances: [{ name: "omb-vps-abc", state: "running", ownerBotId: "bot1", ownerName: "Scout", orphaned: false, inUse: false }],
};
const unconfiguredBoxes: ManagedBoxInventory = { configured: false, available: false, problem: null, instances: [] };

function deps(overrides: Partial<ComputerInventoryRouteDeps> = {}): ComputerInventoryRouteDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    listBoxes: async () => unconfiguredBoxes,
    listVps: async () => healthyVps,
    vpsAlias: () => "nation-vps",
    deadlineMs: 60,
    log: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

async function get(base: string, path: string) {
  const started = Date.now();
  const response = await fetch(`${base}${path}`);
  return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() as any, ms: Date.now() - started };
}

describe("Settings desk inventories", () => {
  it("answers a provider that never replies with 200 and a NATION reason inside the deadline", async () => {
    const d = deps({ listVps: () => new Promise<ManagedVpsInventory>(() => {}) });
    const base = await serve(d);
    const reply = await get(base, "/api/computers/vps");
    expect(reply.status).toBe(200);
    expect(reply.cache).toBe("private, no-store");
    expect(reply.body).toEqual({ configured: true, available: false, sshAlias: "nation-vps", problem: DESKS_SLOW, instances: [] });
    expect(reply.ms).toBeLessThan(2_000);
    expect(d.lines).toEqual([expect.stringContaining("computer inventory (vps) unavailable: no answer within")]);
  });

  it("turns a thrown provider error into 200 without leaking its wording", async () => {
    const d = deps({ listBoxes: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:443 via ascii.dev"); } });
    const base = await serve(d);
    const reply = await get(base, "/api/computers/boxes");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ configured: true, available: false, problem: DESKS_UNREACHABLE, instances: [] });
    expect(JSON.stringify(reply.body)).not.toMatch(/ECONNREFUSED|ascii|10\.0\.0\.5/);
    expect(d.lines.join("\n")).toContain("ECONNREFUSED 10.0.0.5:443");
  });

  it("replaces Docker/SSH and provider wording with NATION copy and logs the real cause", async () => {
    const d = deps({
      listVps: async () => ({
        configured: true,
        available: false,
        sshAlias: "nation-vps",
        problem: "Docker over SSH could not list managed computers: Permission denied (publickey)",
        instances: [],
      }),
      listBoxes: async () => ({ configured: true, available: false, problem: "ascii.dev rejected the Box API key", credentialRejected: true, instances: [] }),
    });
    const base = await serve(d);
    const vps = await get(base, "/api/computers/vps");
    expect(vps.status).toBe(200);
    expect(vps.body.problem).toBe(DESKS_UNREACHABLE);
    const boxes = await get(base, "/api/computers/boxes");
    expect(boxes.body.problem).toBe(DESK_KEY_REJECTED);
    expect(JSON.stringify([vps.body, boxes.body])).not.toMatch(/Docker|SSH|publickey|ascii|\bBox\b/);
    expect(d.lines.join("\n")).toMatch(/Permission denied \(publickey\)/);
  });

  it("passes a healthy or unconfigured answer through unchanged", async () => {
    const base = await serve(deps());
    expect((await get(base, "/api/computers/vps")).body).toEqual(healthyVps);
    expect((await get(base, "/api/computers/boxes")).body).toEqual(unconfiguredBoxes);
  });

  it("joins a refresh to the listing still in flight instead of opening another", async () => {
    let finish!: (value: ManagedVpsInventory) => void;
    const listVps = vi.fn(() => new Promise<ManagedVpsInventory>((resolve) => { finish = resolve; }));
    const base = await serve(deps({ listVps, deadlineMs: 5_000 }));
    const first = get(base, "/api/computers/vps");
    const second = get(base, "/api/computers/vps");
    await vi.waitFor(() => expect(listVps).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    finish(healthyVps);
    expect((await first).body).toEqual(healthyVps);
    expect((await second).body).toEqual(healthyVps);
    expect(listVps).toHaveBeenCalledTimes(1);
    // settled: the next read asks the provider again
    listVps.mockImplementation(async () => healthyVps);
    await get(base, "/api/computers/vps");
    expect(listVps).toHaveBeenCalledTimes(2);
  });

  it("logs a repeated failure once, and a late rejection after the deadline stays handled", async () => {
    const d = deps({
      listVps: () => new Promise<ManagedVpsInventory>((_, reject) => setTimeout(() => reject(new Error("late")), 400)),
    });
    const base = await serve(d);
    expect((await get(base, "/api/computers/vps")).body.problem).toBe(DESKS_SLOW);
    expect((await get(base, "/api/computers/vps")).body.problem).toBe(DESKS_SLOW);
    expect(d.lines).toHaveLength(1);
    // the listing both reads joined rejects after they answered: no unhandled rejection
    await new Promise((resolve) => setTimeout(resolve, 450));
  });

  it("never hands the SSH alias to a response that is not the owner's", async () => {
    const base = await serve(deps({ listVps: () => new Promise<ManagedVpsInventory>(() => {}) }), false);
    const reply = await get(base, "/api/computers/vps");
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ configured: true, available: false, problem: DESKS_SLOW, instances: [] });
  });

  it("leaves other methods and paths to the inline routes", async () => {
    const base = await serve(deps());
    expect((await fetch(`${base}/api/computers/vps/omb-vps-abc/remove`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/api/computers/boxes`, { method: "POST" })).status).toBe(404);
  });
});
