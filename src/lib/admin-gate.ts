/** Product-admin gate: engine / Composio / VPS / build details stay owner-only. */
const STORAGE_KEY = "nation.adminUnlocked";

export type AdminGateStatus = {
  unlocked: boolean;
  /** True when a PIN is configured server-side and required to unlock. */
  pinRequired: boolean;
};

export function readAdminUnlocked(): boolean {
  try {
    return sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAdminUnlocked(unlocked: boolean): void {
  try {
    if (unlocked) sessionStorage.setItem(STORAGE_KEY, "1");
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Whether the current session is the product owner / admin.
 *
 * Decision order (first match wins):
 *  1. `isProductOwner` — authoritative server verdict injected into /api/config.
 *     When present, trust it unconditionally for remote-client gating, but
 *     still apply the local PIN gate on top (so the desktop owner can add a
 *     PIN as a second lock even on a loopback session).
 *  2. Legacy heuristic (desktop-only fallback when the field has not arrived yet):
 *     - remoteClient=true  → always false
 *     - pinRequired=true   → check sessionStorage unlock
 *     - otherwise          → true (local loopback desktop = owner)
 */
export function isProductAdmin(options: {
  /** window.ogb?.remoteClient?.active */
  remoteClient?: boolean;
  /** state.config?.adminGate?.pinRequired */
  pinRequired?: boolean;
  /** already-read sessionStorage value; omit to read live */
  unlocked?: boolean;
  /**
   * state.config?.isProductOwner — server-authoritative flag.
   * When defined, prevents non-admin hosted-server sessions from ever
   * being treated as admin, regardless of remoteClient/pinRequired.
   */
  isProductOwner?: boolean;
}): boolean {
  const unlocked = options.unlocked ?? readAdminUnlocked();

  // Server says "not the owner" → deny immediately, even on loopback, so
  // a non-admin browser session on a local server can't sneak through.
  if (options.isProductOwner === false) return false;

  // remoteClient is a paired non-owner device — always deny regardless of
  // what the server said (belt-and-suspenders: server already says false here).
  if (options.remoteClient) return false;

  // Server confirmed owner but PIN gate adds a local UI lock on top.
  if (options.pinRequired) return unlocked;

  // Server confirmed owner with no additional PIN gate.
  if (options.isProductOwner === true) return true;

  // No server verdict yet (config still loading) — fall back to safe heuristic.
  // This only runs before the first /api/config response arrives.
  return false;
}

/**
 * Settings section ids that are admin-only.
 * "engines" is intentionally absent — it no longer lives in Settings at all;
 * it is only accessible via the Admin page.
 */
export const ADMIN_ONLY_SETTINGS_SECTIONS = new Set([
  "connections",
  "experimental",
  "workspaces",
]);

export function isAdminOnlySettingsSection(id: string): boolean {
  return ADMIN_ONLY_SETTINGS_SECTIONS.has(id);
}
