import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Deployment settings are renamed without invalidating existing VPS settings. */
export function nationEnv(name: string, legacy: string | string[], env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env[name] !== undefined) return env[name];
  for (const key of typeof legacy === "string" ? [legacy] : legacy) {
    if (env[key] !== undefined) return env[key];
  }
  return undefined;
}

/** Never create an empty fleet over an existing installation, move data, or delete it. */
export function nationDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = nationEnv("NATION_DATA_DIR", ["OPENMAUS_DATA_DIR", "OPENMAUSBOT_DATA_DIR", "OMB_DATA_DIR"], env);
  if (explicit !== undefined) return explicit;
  const current = join(home, ".nationteamchat");
  if (existsSync(current)) return current;
  for (const old of [".openmausbot", ".opengrokbot"]) {
    const candidate = join(home, old);
    if (existsSync(candidate)) return candidate;
  }
  return current;
}
