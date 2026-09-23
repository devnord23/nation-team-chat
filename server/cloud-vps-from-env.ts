/**
 * Cloud VPS connection from gitignored .env.local (VPS_*).
 * Secrets stay in env — never in git or API responses.
 */
export type VpsAuthMethod = "password" | "key";

export type CloudVpsPublicStatus = {
  configured: boolean;
  ready: boolean;
  host: string | null;
  user: string | null;
  port: number;
  label: string;
  authMethod: VpsAuthMethod;
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
  const password = trim(env.VPS_PASSWORD);
  const sshKeyPath = trim(env.VPS_SSH_KEY_PATH);
  const authSecretPresent = authMethod === "password" ? password.length > 0 : sshKeyPath.length > 0;

  const missing: string[] = [];
  if (!host) missing.push("VPS_HOST");
  if (!user) missing.push("VPS_USER");
  if (authMethod === "password" && !password) missing.push("VPS_PASSWORD");
  if (authMethod === "key" && !sshKeyPath) missing.push("VPS_SSH_KEY_PATH");

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
