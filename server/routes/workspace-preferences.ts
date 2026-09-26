// PATCH /api/workspace/preferences: the few settings that belong to whoever
// uses a workspace rather than to its operator: first-run progress (the
// welcome flow and tour hints), the interface language and the display name.
//
// In a workspace of one's own (server/workspace-host.ts) the signed-in
// account is the only person there, so a `client` session may save these.
// On a shared desk they belong to its owner: members are refused, exactly as
// they are on PUT /api/config, and an admin may use either route.
import { z } from "zod";
import { PASS, type RouteHandler } from "./table.ts";

export const workspacePreferencesSchema = z.object({
  language: z.string().trim().max(40).optional(),
  profile: z.object({ name: z.string().trim().max(80) }).strict().optional(),
  onboarding: z.object({
    completedAt: z.string().trim().max(40).optional(),
    version: z.number().int().min(0).max(1000).optional(),
    reelSeen: z.boolean().optional(),
    hintsSeen: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
  }).strict().optional(),
}).strict();

export type WorkspacePreferences = z.infer<typeof workspacePreferencesSchema>;

export function createWorkspacePreferencesRoutes(deps: {
  /** True only in a workspace server started for one account. */
  personalWorkspace: boolean;
  /** Persist the patch, tell open windows, and return the caller's view of the config. */
  save(patch: WorkspacePreferences, admin: boolean): unknown;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/workspace/preferences") return PASS;
    if (method !== "PATCH") return json(res, 405, { error: "use PATCH" });
    const admin = auth.scopes.includes("admin");
    if (!admin && !deps.personalWorkspace) return json(res, 403, { error: "Only the workspace owner can change this." });
    const parsed = workspacePreferencesSchema.safeParse(await readBody(req, 16_384));
    if (!parsed.success || !Object.keys(parsed.data).length) return json(res, 400, { error: "nothing to save" });
    return json(res, 200, deps.save(parsed.data, admin));
  };
}
