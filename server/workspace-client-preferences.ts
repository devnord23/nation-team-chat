import { WORKSPACE_BACKUP_CLIENT_KEYS } from "../shared/workspace-backup-client.ts";
const legacyKeys: Record<string, string> = {
  "openmausbot.sidebarDensity": "nation.sidebarDensity",
  "openmausbot.sidebarCollapsedSections.v1": "nation.sidebarCollapsedSections.v1",
  "openmausbot.sidebarSectionOrder.v1": "nation.sidebarSectionOrder.v1",
  "openmausbot.remote-voice.v1": "nation.remote-voice.v1",
};
/** Import exact historical preference keys; never accept credentials or arbitrary browser state. */
export function workspaceClientPreferences(input: Record<string, string>): Record<string, string> {
  const allowed = new Set<string>(WORKSPACE_BACKUP_CLIENT_KEYS);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const canonical = Object.hasOwn(legacyKeys, key) ? legacyKeys[key] : key;
    if (!allowed.has(canonical) || typeof value !== "string") throw new Error("Invalid workspace client preferences.");
    if (Object.hasOwn(result, canonical)) throw new Error("Duplicate workspace client preference.");
    result[canonical] = value;
  }
  return result;
}
