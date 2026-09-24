import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const roots: string[] = [];
const guard = fileURLToPath(new URL("./brand-guard.mjs", import.meta.url));
function scan(body: string, filename = "app.js") {
  const root = mkdtempSync(join(tmpdir(), "nation-brand-guard-test-"));
  roots.push(root);
  writeFileSync(join(root, filename), body);
  return spawnSync(process.execPath, [guard, root], { encoding: "utf8" });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("public asset brand guard", () => {
  it.each(["OpenMausBot", "OPEN_MUSE", "open-muse", "ClaudeApiKey", "Anthropic",
    "GitHub", "Hermes", "Venice", "open source", "opensource", "star us",
    "contribute", "Maus", "Nous", "Grok", "xAI", "Cua",
    "/api/cua/start", "engine.grok.model", "provider-nous", "xai/model",
    "xaiApiKey", "cuaHost", "myGrokKey"])(
    "rejects the public name or identifier %s", (name) => {
      const result = scan(JSON.stringify({ label: name }));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("FAIL");
    },
  );
  it("does not invent brands inside ordinary words or encoded payloads", () => {
    const result = scan('const label = "asynchronous continuous"; const payload = "AgBxAiIgRB6AdLDQ0YYCuAMgByAJKAIs";');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 matches");
  });
  it("scans captured API responses as well as scripts", () => {
    expect(scan('{"engine":"Claude"}', "member-response.json").status).toBe(1);
  });
  it("keeps required legal notices exempt without exempting other text files", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-brand-guard-test-"));
    roots.push(root);
    writeFileSync(join(root, "NOTICE"), "OpenMausBot and GitHub attribution");
    writeFileSync(join(root, "app.js"), 'const title = "NATION";');
    expect(spawnSync(process.execPath, [guard, root]).status).toBe(0);
    writeFileSync(join(root, "help.txt"), "OpenMausBot");
    expect(spawnSync(process.execPath, [guard, root]).status).toBe(1);
  });
  it("fails when no deployable text assets exist", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-brand-guard-test-"));
    roots.push(root);
    expect(spawnSync(process.execPath, [guard, root]).status).toBe(1);
  });
});
