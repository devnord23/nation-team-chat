import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// Intentionally readable: a guard must not conceal the terms it checks.
const banned = /openmuse|open muse|open-muse|open_muse|openmaus(?:bot)?|maus|open source|opensource|github|star us|contribute|anthropic|claude|hermes|nous|venice|grok|xai|cua/gi;
const roots = process.argv.slice(2);
if (!roots.length) roots.push("dist");
let scanned = 0;
let failures = 0;
function scan(path) {
  if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) scan(join(path, name)); return; }
  if (/^(LICENSE|NOTICE)(\..*)?$/i.test(basename(path))) return;
  if (!/\.(html|js|mjs|css|json|svg|txt)$/i.test(path)) return;
  scanned++;
  const hits = [...readFileSync(path, "utf8").matchAll(banned)];
  if (!hits.length) return;
  failures += hits.length;
  console.error(`FAIL ${path}: ${hits.length} matches (${[...new Set(hits.map(hit => hit[0].toLowerCase()))].join(", ")})`);
}
try { roots.forEach(scan); } catch (error) { console.error(`FAIL cannot scan: ${error.message}`); process.exit(1); }
if (!scanned) { console.error("FAIL no frontend assets or API captures found"); process.exit(1); }
console.log(`${failures ? "FAIL" : "PASS"} brand-guard: ${scanned} files, ${failures} matches`);
process.exitCode = failures ? 1 : 0;
