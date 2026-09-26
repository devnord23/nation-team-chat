// GET /api/computers/boxes and GET /api/computers/vps: the account-wide desk
// inventories the owner sees in Settings. Reads only; lifecycle actions stay
// in server/index.ts and revalidate against a fresh provider listing.
//
// Opening Settings must never become a gateway error. The provider reads can
// take far longer than a proxy in front of this server will wait (Docker over
// SSH allows 20 s per command, the cloud listing 20 s per page), and a proxy
// that gives up answers with a bare 502. So each read answers 200 within a
// deadline: an empty list and a NATION-owned reason when the provider is slow,
// down or misconfigured, while the real cause goes to the server log. The
// provider's own error wording (Docker, SSH, the cloud API) never reaches the page.
//
// Admin scope only: these paths are not in CLIENT_ALLOW (server/request-auth.ts).
import type { ManagedBoxInventory } from "../box.ts";
import { redactSecretsInText } from "../redact.ts";
import type { ManagedVpsInventory } from "../vps-computer.ts";
import { PASS, type RouteHandler } from "./table.ts";

/** Well inside any proxy's patience; a healthy listing takes a second or two. */
export const INVENTORY_DEADLINE_MS = 8_000;
export const DESKS_SLOW = "NATION desks did not answer in time. Try again in a minute.";
export const DESKS_UNREACHABLE = "NATION desks are unreachable right now. Try again in a minute; the server log has the details.";
export const DESK_KEY_REJECTED = "The saved desk access key was rejected. Update it in Settings → Connections.";

type Kind = "boxes" | "vps";
type Inventory = ManagedBoxInventory | ManagedVpsInventory;

export interface ComputerInventoryRouteDeps {
  listBoxes(): Promise<ManagedBoxInventory>;
  listVps(): Promise<ManagedVpsInventory>;
  /** The configured SSH alias, kept on the owner's fallback row; null when none. */
  vpsAlias(): string | null;
  /** Tests shorten it. */
  deadlineMs?: number;
  /** Defaults to console.warn. */
  log?: (line: string) => void;
}

const LOG_REPEAT_MS = 60_000;

export function createComputerInventoryRoutes(deps: ComputerInventoryRouteDeps): RouteHandler {
  const deadlineMs = deps.deadlineMs ?? INVENTORY_DEADLINE_MS;
  const log = deps.log ?? ((line: string) => console.warn(line));
  // One provider listing per kind at a time: a refresh while a slow listing
  // is still running joins it instead of opening another SSH session.
  const inflight = new Map<Kind, Promise<Inventory>>();
  const lastLogged = new Map<Kind, { line: string; at: number }>();

  const report = (kind: Kind, detail: string) => {
    const line = `computer inventory (${kind}) unavailable: ${redactSecretsInText(detail.replace(/\s+/g, " ").trim()).slice(0, 300)}`;
    const previous = lastLogged.get(kind);
    const now = Date.now();
    if (previous?.line === line && now - previous.at < LOG_REPEAT_MS) return;
    lastLogged.set(kind, { line, at: now });
    log(line);
  };

  const fallback = (kind: Kind, problem: string): Inventory => kind === "vps"
    ? { configured: true, available: false, sshAlias: deps.vpsAlias(), problem, instances: [] }
    : { configured: true, available: false, problem, instances: [] };

  const read = async (kind: Kind): Promise<Inventory> => {
    let pending = inflight.get(kind);
    if (!pending) {
      const started = Promise.resolve().then((): Promise<Inventory> => kind === "vps" ? deps.listVps() : deps.listBoxes());
      const clear = () => { if (inflight.get(kind) === started) inflight.delete(kind); };
      started.then(clear, clear);
      inflight.set(kind, started);
      pending = started;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then((value) => ({ value }), (error: unknown) => ({ error })),
      new Promise<{ late: true }>((resolve) => {
        timer = setTimeout(() => resolve({ late: true }), deadlineMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));

    if ("late" in outcome) {
      report(kind, `no answer within ${Math.round(deadlineMs / 100) / 10} s`);
      return fallback(kind, DESKS_SLOW);
    }
    if ("error" in outcome) {
      report(kind, outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
      return fallback(kind, DESKS_UNREACHABLE);
    }
    const value = outcome.value;
    if (!value || typeof value !== "object" || !Array.isArray(value.instances)) {
      report(kind, "the provider returned a malformed inventory");
      return fallback(kind, DESKS_UNREACHABLE);
    }
    // Healthy, or nothing configured to ask: the provider's answer stands.
    if (value.available || !value.configured) return value;
    report(kind, value.problem ?? "the provider reported no reason");
    const rejected = "credentialRejected" in value && value.credentialRejected === true;
    return { ...value, instances: [], problem: rejected ? DESK_KEY_REJECTED : DESKS_UNREACHABLE };
  };

  return async ({ res, path, method, json }) => {
    if (method !== "GET" || (path !== "/api/computers/boxes" && path !== "/api/computers/vps")) return PASS;
    res.setHeader("cache-control", "private, no-store");
    return json(res, 200, await read(path === "/api/computers/vps" ? "vps" : "boxes"));
  };
}
