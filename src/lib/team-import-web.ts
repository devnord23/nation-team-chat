import { api } from "@/state/store";
import type { PendingTeamImport } from "./team-import";
export type { PendingTeamImport } from "./team-import";

/** Parsing legacy imports belongs to the authenticated server. */
export async function teamImportPreview(manifest: unknown): Promise<PendingTeamImport> {
  return api("/api/teams/import-preview", { method: "POST", body: JSON.stringify({ manifest }) });
}
