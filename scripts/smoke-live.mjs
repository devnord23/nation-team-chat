import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { nationDataDir } from "../server/nation-compat.ts";
import { brandHits } from "./brand-terms.mjs";

const args = new Set(process.argv.slice(2));
const env = process.env;
const site = env.NATION_SMOKE_SITE || "https://thenation.city/swarm/";
const apiOrigin = env.NATION_SMOKE_API || "http://127.0.0.1:8799";
const output = resolve(env.NATION_SMOKE_OUTPUT || "/tmp/nation-smoke");
mkdirSync(output, { recursive: true, mode: 0o700 });
let failures = 0, cookie = "", bot, memberId;
const assert = (value, message) => { if (!value) throw new Error(message); };
async function check(name, work) {
  try { await work(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
}
function snapshot(directory) {
  assert(existsSync(directory), "Data directory missing");
  const bots = JSON.parse(readFileSync(join(directory, "bots.json"), "utf8"));
  const db = new DatabaseSync(join(directory, "messages.db"), { readOnly: true });
  try { return { bots: bots.map(bot => bot.id).sort(), messages: db.prepare("SELECT thread_id,id FROM messages ORDER BY thread_id,id").all() }; }
  finally { db.close(); }
}
if (args.has("--record-data")) {
  const path = join(output, "data-before.json");
  writeFileSync(path, JSON.stringify(snapshot(nationDataDir())), { mode: 0o600 });
  console.log(`PASS pre-deployment data inventory saved: ${path}`);
  process.exit(0);
}
async function api(path, { method = "GET", body, admin = false } = {}) {
  const token = admin ? env.NATION_SMOKE_ADMIN_TOKEN : env.NATION_SMOKE_MEMBER_TOKEN;
  assert(token, `Set NATION_SMOKE_${admin ? "ADMIN" : "MEMBER"}_TOKEN for a dedicated test account`);
  const response = await fetch(apiOrigin + path, { method, signal: AbortSignal.timeout(120_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!admin && response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
  const value = await response.json();
  if (!admin) assert(brandHits(JSON.stringify(value)).length === 0, "Member API response contains a banned term");
  return { status: response.status, value };
}
await check("1. Swarm HTML and referenced JavaScript contain no banned words", async () => {
  const visited = new Set(), queue = [site];
  while (queue.length) {
    const url = queue.shift(); if (visited.has(url)) continue; visited.add(url);
    assert(visited.size < 2000, "Asset graph exceeded safety bound");
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    assert(response.status === 200, `Asset returned ${response.status}: ${url}`);
    const text = await response.text();
    assert(brandHits(text).length === 0, `Banned term in ${url}`);
    for (const match of text.matchAll(/["']([^"'\s<>]+\.(?:m?js|css)(?:\?[^"'\s<>]*)?)["']/g)) {
      const next = new URL(match[1], match[1].startsWith("assets/") ? site : url);
      if (next.origin === new URL(site).origin) queue.push(next.href);
    }
  }
  assert(visited.size > 1, "No JavaScript assets were examined");
});
await check("2. API health, PM2 and port 8799", async () => {
  assert(new URL(apiOrigin).port === "8799", "Live API must use port 8799");
  const response = await fetch(apiOrigin + "/api/health", { signal: AbortSignal.timeout(15_000) });
  assert(response.status === 200, `API health returned ${response.status}`);
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15_000 }));
  assert(processes.some(item => item.name === "nation-team-chat-api" && item.pm2_env?.status === "online"), "nation-team-chat-api is not online");
});
await check("3. Create a bot and receive a billed NATION reply", async () => {
  assert(args.has("--exercise"), "Use --exercise to create a test bot and spend the test account's credit");
  const before = await api("/api/admin/credits", { admin: true }); assert(before.status === 200, "Admin ledger unavailable");
  const credit = await api("/api/credits/status");
  assert(credit.status === 200 && credit.value.verified && !credit.value.exempt, "A fresh verified regular account is required");
  assert(credit.value.balanceUsd === Number(env.NATION_FREE_CREDIT_USD || 3), "Starter credit does not match configured amount");
  const granted = await api("/api/admin/credits", { admin: true });
  const previousIds = new Set(before.value.ledger.map(row => row.id));
  const free = granted.value.ledger.filter(row => row.type === "free" && !previousIds.has(row.id));
  assert(free.length === 1, "Use a fresh verified account that has not already claimed starter credit");
  memberId = free[0].user_id;
  const created = await api("/api/bots", { method: "POST", body: { name: `NATION smoke ${Date.now()}` } });
  assert(created.status === 201, "Bot creation failed"); bot = created.value.bot;
  const sent = await api(`/api/bots/${bot.id}/messages`, { method: "POST", body: { threadId: bot.threadId, text: "Introduce yourself in one short sentence. Do not use tools." } });
  assert(sent.status === 202, "Chat was not accepted");
  let usage = [], replied = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const messages = await api(`/api/threads/${bot.threadId}/messages`);
    replied = messages.value.messages?.some(message => message.role === "bot" && message.kind === "text" && message.text?.trim());
    const state = await api("/api/admin/credits", { admin: true });
    usage = state.value.ledger.filter(row => row.user_id === memberId && row.type === "usage");
    if (replied && usage.length && !state.value.pendingCosts.some(call => call.user_id === memberId)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(replied && usage.length, "No bot reply with settled model cost within 60 seconds");
  const cost = usage.reduce((sum, row) => sum + row.cost_micros, 0);
  const debit = -usage.reduce((sum, row) => sum + row.amount_micros, 0);
  assert(cost > 0 && debit > 0, "No positive actual provider cost was recorded");
  const after = await api("/api/credits/status");
  assert(Math.abs(credit.value.balanceUsd - after.value.balanceUsd - debit / 1e6) < .000002, "Balance does not match usage ledger");
  writeFileSync(join(output, "chat-cost.json"), JSON.stringify({ botId: bot.id, costMicros: cost, debitMicros: debit }), { mode: 0o600 });
  console.log(`Evidence: test bot ${bot.id}; cost $${(cost / 1e6).toFixed(6)}; debit $${(debit / 1e6).toFixed(6)}`);
});
await check("4. VPS desk opens with the approved wallpaper and Chrome", async () => {
  assert(bot, "Create the test bot successfully first");
  const status = await api(`/api/bots/${bot.id}/computer?threadId=${bot.threadId}`);
  assert(status.status === 200 && status.value.backend === "vps" && status.value.ready, "VPS desk is not ready");
  assert(!/not configured|\bSSH\b|\bBox\b/i.test(JSON.stringify(status.value)), "Regular desk response exposes setup UI");
  const joined = await api(`/api/bots/${bot.id}/computer/join?threadId=${bot.threadId}`, { method: "POST", body: {} });
  assert(joined.status === 200, "Desk viewer could not open");
  const shot = await api(`/api/bots/${bot.id}/computer/screenshot?threadId=${bot.threadId}`, { method: "POST", body: {} });
  assert(shot.status === 200 && shot.value.png, "Desk screenshot unavailable");
  writeFileSync(join(output, `desk.${shot.value.format === "jpeg" ? "jpg" : "png"}`), Buffer.from(shot.value.png, "base64"), { mode: 0o600 });
  const container = env.NATION_SMOKE_DESK_CONTAINER;
  assert(container && /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(container), "Set NATION_SMOKE_DESK_CONTAINER for the test bot's desk; inspect the saved screenshot");
  const desktop = execFileSync("docker", ["exec", "--user", "cua", "-e", "DISPLAY=:1", container, "xfconf-query", "-c", "xfce4-desktop", "-lv"], { encoding: "utf8", timeout: 15_000 });
  const wallpaper = desktop.split("\n").find(line => /last-image/.test(line))?.trim().split(/\s+/).at(-1);
  assert(wallpaper && env.NATION_SMOKE_WALLPAPER_SHA256, "Set the SHA256 of the approved current wallpaper");
  const hash = execFileSync("docker", ["exec", container, "sha256sum", wallpaper], { encoding: "utf8", timeout: 15_000 }).split(/\s+/)[0];
  assert(hash === env.NATION_SMOKE_WALLPAPER_SHA256, "Active wallpaper differs from the approved Nation wallpaper");
  execFileSync("docker", ["exec", container, "pgrep", "-f", "google-chrome|/chrome"], { timeout: 15_000 });
});
await check("5. Zero credit blocks calls and the test adjustment is restored", async () => {
  assert(bot && memberId, "Starter-credit and chat check must pass first");
  const state = await api("/api/admin/credits", { admin: true });
  const user = state.value.users.find(item => item.id === memberId);
  assert(user?.balance_micros > 0, "Test account needs a positive remaining balance");
  const amount = user.balance_micros / 1e6;
  const adjusted = await api("/api/admin/credits/adjust", { method: "POST", admin: true, body: { userId: memberId, amountUsd: -amount, reason: "Smoke test: temporarily exercise zero balance" } });
  assert(adjusted.status === 200, "Could not temporarily remove test credit");
  try {
    const blocked = await api(`/api/bots/${bot.id}/messages`, { method: "POST", body: { threadId: bot.threadId, text: "This request must be blocked without a model call." } });
    assert(blocked.status === 402, `Expected HTTP 402, got ${blocked.status}`);
    const after = await api("/api/admin/credits", { admin: true });
    assert(after.value.ledger.filter(row => row.user_id === memberId && row.type === "usage").length === state.value.ledger.filter(row => row.user_id === memberId && row.type === "usage").length, "Blocked request created model usage");
  } finally {
    const restored = await api("/api/admin/credits/adjust", { method: "POST", admin: true, body: { userId: memberId, amountUsd: amount, reason: "Smoke test: restore temporary zero-balance adjustment" } });
    assert(restored.status === 200, `Restore test credit manually: ${memberId}, $${amount}`);
  }
});
await check("6. Connector management is owner-only", async () => {
  for (const path of ["/api/connectors/catalog", "/api/connectors/connected", "/api/mcp/servers"]) {
    assert((await api(path)).status === 403, `Member can read ${path}`);
    assert((await api(path, { admin: true })).status === 200, `Owner cannot read ${path}`);
  }
  const response = await fetch(new URL("connectors", site), { signal: AbortSignal.timeout(15_000) });
  assert(response.status === 200, `Connected-app screen returns ${response.status}`);
});
await check("7. Existing bots and messages survive the data-directory rename", async () => {
  const path = env.NATION_SMOKE_BASELINE || join(output, "data-before.json");
  assert(existsSync(path), "Run --record-data before deployment and retain its inventory");
  const before = JSON.parse(readFileSync(path, "utf8")), after = snapshot(nationDataDir());
  const bots = new Set(after.bots), messages = new Set(after.messages.map(row => `${row.thread_id}:${row.id}`));
  assert(before.bots.every(id => bots.has(id)), "An existing bot is missing");
  assert(before.messages.every(row => messages.has(`${row.thread_id}:${row.id}`)), "An existing message is missing");
  const old = join(homedir(), ".openmausbot");
  if (existsSync(old)) assert(existsSync(join(old, "bots.json")), "Legacy source data must remain intact");
});
await check("SQLite integrity and WAL mode", async () => {
  for (const name of ["messages.db", "nation-credits.db"]) {
    const db = new DatabaseSync(join(nationDataDir(), name), { readOnly: true });
    try {
      assert(Object.values(db.prepare("PRAGMA quick_check").get())[0] === "ok", `${name} integrity failed`);
      assert(Object.values(db.prepare("PRAGMA journal_mode").get())[0] === "wal", `${name} is not using WAL`);
    } finally { db.close(); }
  }
});
console.log(`${failures ? "FAIL" : "PASS"}: ${failures} failed checks. Evidence: ${output}`);
process.exitCode = failures ? 1 : 0;
