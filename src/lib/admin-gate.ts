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
 * Local desktop host is the default product owner.
 * Remote clients are never admins unless explicitly unlocked (shouldn't happen).
 * When a PIN is configured, require unlock even on the host.
 */
export function isProductAdmin(options: {
  remoteClient?: boolean;
  pinRequired?: boolean;
  unlocked?: boolean;
}): boolean {
  const unlocked = options.unlocked ?? readAdminUnlocked();
  if (options.remoteClient) return false;
  if (options.pinRequired) return unlocked;
  // Host desktop / local web without PIN: owner machine.
  return true;
}

/** Settings section ids that expose engine, keys, VPS, or build internals. */
export const ADMIN_ONLY_SETTINGS_SECTIONS = new Set([
  "engines",
  "connections",
  "experimental",
  "workspaces",
]);

export function isAdminOnlySettingsSection(id: string): boolean {
  return ADMIN_ONLY_SETTINGS_SECTIONS.has(id);
}
