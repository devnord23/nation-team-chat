import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nationDataDir, nationEnv } from "./nation-compat.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("NATION deployment compatibility", () => {
  it("gives the new environment setting precedence, including deliberate empty values", () => {
    expect(nationEnv("NATION_X", "OPENMAUS_X", { NATION_X: "new", OPENMAUS_X: "old" })).toBe("new");
    expect(nationEnv("NATION_X", "OPENMAUS_X", { NATION_X: "", OPENMAUS_X: "old" })).toBe("");
    expect(nationEnv("NATION_X", "OPENMAUS_X", { OPENMAUS_X: "old" })).toBe("old");
  });
  it("reuses all existing fleet data without moving or deleting anything", () => {
    const home = mkdtempSync(join(tmpdir(), "nation-compat-")); roots.push(home);
    const legacy = join(home, ".openmausbot"); mkdirSync(legacy);
    writeFileSync(join(legacy, "bots.json"), '[{"id":"existing"}]');
    expect(nationDataDir({}, home)).toBe(legacy);
    expect(readFileSync(join(nationDataDir({}, home), "bots.json"), "utf8")).toContain("existing");
    mkdirSync(join(home, ".nationteamchat"));
    expect(nationDataDir({}, home)).toBe(join(home, ".nationteamchat"));
    expect(readFileSync(join(legacy, "bots.json"), "utf8")).toContain("existing");
    expect(nationDataDir({ NATION_DATA_DIR: "/fixture", OMB_DATA_DIR: "/old" }, home)).toBe("/fixture");
  });
});
