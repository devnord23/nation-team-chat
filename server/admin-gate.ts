/** Admin gate status for the UI — never returns the PIN itself. */
export function adminGatePublicStatus(env: NodeJS.ProcessEnv = process.env): {
  pinRequired: boolean;
} {
  const pin = (env.NATION_ADMIN_PIN ?? "").trim();
  return { pinRequired: pin.length > 0 };
}

export function adminPinMatches(candidate: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pin = (env.NATION_ADMIN_PIN ?? "").trim();
  if (!pin) return true;
  return candidate === pin;
}
