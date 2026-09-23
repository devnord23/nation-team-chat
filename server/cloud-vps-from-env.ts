/**
 * Cloud VPS connection from gitignored .env.local (VPS_*).
 * Secrets stay in env — never in git or API responses.
 *
 * Key sources (either suffices for key auth):
 *   VPS_SSH_KEY_PATH — path to a PEM private-key file
 *   VPS_SSH_KEY      — raw PEM private-key content (for containerised deployments)
 *
 * Password-only auth is NEVER sufficient for the live desktop path.
 */
export type VpsAuthMethod = "password" | "key";

export type CloudVpsPublicStatus = {
  configured: boolean;
  /** True only when host + user + at least one key source are present.
   * Password-only configurations are never ready. */
  ready: boolean;
  host: string | null;
  user: string | null;
  port: number;
  label: string;
  authMethod: VpsAuthMethod;
  /** True when a key is available (path or inline content), regardless of authMethod. */
  authSecretPresent: boolean;
  sshAlias: string | null;
  missing: string[];
};

function trim(v: string | undefined): string {
  return (v ?? "").trim();
}

export function cloudVpsPublicStatus(env: NodeJS.ProcessEnv = process.env): CloudVpsPublicStatus {
  const host = trim(env.VPS_HOST);
  const user = trim(env.VPS_USER);
  const label = trim(env.VPS_LABEL) || "cloud-vps";
  const sshAlias = trim(env.VPS_SSH_ALIAS) || null;
  const portRaw = trim(env.VPS_SSH_PORT) || "22";
  const portNum = Number(portRaw);
  const port = Number.isFinite(portNum) && portNum > 0 ? portNum : 22;
  const authMethod = (trim(env.VPS_AUTH_METHOD).toLowerCase() === "password" ? "password" : "key") as VpsAuthMethod;

  // Accept either a file path or inline key content.
  const sshKeyPath = trim(env.VPS_SSH_KEY_PATH);
  const sshKeyContent = trim(env.VPS_SSH_KEY);
  const hasKey = sshKeyPath.length > 0 || sshKeyContent.length > 0;

  // A key (path or inline) is always required — password alone is not accepted.
  const authSecretPresent = hasKey;

  const missing: string[] = [];
  if (!host) missing.push("VPS_HOST");
  if (!user) missing.push("VPS_USER");
  if (!hasKey) {
    // Report the canonical env var name; operators may use either.
    missing.push("VPS_SSH_KEY_PATH (or VPS_SSH_KEY)");
  }

  return {
    configured: Boolean(host && user),
    ready: missing.length === 0,
    host: host || null,
    user: user || null,
    port,
    label,
    authMethod,
    authSecretPresent,
    sshAlias,
    missing,
  };
}
