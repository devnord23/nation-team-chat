// Where this session saves its own first-run progress, language and display
// name. The desk's owner saves them with the rest of the config; in a Nation
// account's own workspace its member saves them through the narrow
// preferences route (server/routes/workspace-preferences.ts). A member of a
// shared desk saves neither: those settings are its owner's.
type Config = { isProductOwner?: boolean; personalWorkspace?: boolean } | null | undefined;

export function preferencesRoute(config: Config): { path: string; method: "PUT" | "PATCH" } | null {
  if (config?.isProductOwner !== false) return { path: "/api/config", method: "PUT" };
  return config.personalWorkspace === true ? { path: "/api/workspace/preferences", method: "PATCH" } : null;
}

/** A member of their own workspace (never the owner of a desk). */
export function personalMember(config: Config): boolean {
  return config?.isProductOwner === false && config.personalWorkspace === true;
}
