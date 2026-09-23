/**
 * Admin gate status for the UI — never returns the PIN itself.
 *
 * Two env vars control admin access:
 *   NATION_PRODUCT_ADMIN=1  — unconditionally enables admin mode on this
 *                              server (no PIN required; intended for self-hosted
 *                              owner deployments).
 *   NATION_ADMIN_PIN=<pin>  — requires the user to enter the PIN in Settings
 *                              before admin sections become visible.
 *
 * When NATION_PRODUCT_ADMIN is not set, admin sections are hidden from all
 * users (including the local desktop owner) unless a PIN is entered.
 */

export function adminGatePublicStatus(env: NodeJS.ProcessEnv = process.env): {
  pinRequired: boolean;
} {
  // NATION_PRODUCT_ADMIN=1 means the operator has explicitly declared this an
  // admin deployment — no PIN gate needed.
  if ((env.NATION_PRODUCT_ADMIN ?? "").trim() === "1") {
    return { pinRequired: false };
  }
  const pin = (env.NATION_ADMIN_PIN ?? "").trim();
  return { pinRequired: pin.length > 0 };
}

export function adminPinMatches(candidate: string, env: NodeJS.ProcessEnv = process.env): boolean {
  // Admin mode always open — no PIN to match against.
  if ((env.NATION_PRODUCT_ADMIN ?? "").trim() === "1") return true;
  const pin = (env.NATION_ADMIN_PIN ?? "").trim();
  if (!pin) return true;
  return candidate === pin;
}
