import { expect, it } from "vitest";
import { workspaceClientPreferences } from "./workspace-client-preferences.ts";
it("preserves legacy encrypted-backup preferences under canonical keys", () => {
  const old = { "openmausbot.sidebarDensity": "compact", "omb-drafts": "saved draft" };
  expect(workspaceClientPreferences(old)).toEqual({ "nation.sidebarDensity": "compact", "omb-drafts": "saved draft" });
  expect(old["openmausbot.sidebarDensity"]).toBe("compact");
});
it("rejects credential keys, unknown keys, and ambiguous duplicate preferences", () => {
  for (const value of [{ token: "secret" }, { "__proto__": null, other: "bad" },
    { "openmausbot.sidebarDensity": "compact", "nation.sidebarDensity": "icons" }])
    expect(() => workspaceClientPreferences(value as unknown as Record<string, string>)).toThrow("preference");
});
