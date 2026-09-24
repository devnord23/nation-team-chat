import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

import { brandHits } from "./brand-terms.mjs";

const roots = process.argv.slice(2);
if (!roots.length) roots.push("dist");
let scanned = 0;
let failures = 0;
function scan(path) {
  if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) scan(join(path, name)); return; }
  if (/^(LICENSE|NOTICE)(\..*)?$/i.test(basename(path))) return;
  if (!/\.(html|js|mjs|css|json|svg|txt)$/i.test(path)) return;
  scanned++;
  const hits = brandHits(readFileSync(path, "utf8"));
  if (!hits.length) return;
  failures += hits.length;
  console.error(`FAIL ${path}: ${hits.length} matches (${[...new Set(hits.map(hit => hit[0].toLowerCase()))].join(", ")})`);
}
try { roots.forEach(scan); } catch (error) { console.error(`FAIL cannot scan: ${error.message}`); process.exit(1); }
if (!scanned) { console.error("FAIL no frontend assets or API captures found"); process.exit(1); }
console.log(`${failures ? "FAIL" : "PASS"} brand-guard: ${scanned} files, ${failures} matches`);
process.exitCode = failures ? 1 : 0;
