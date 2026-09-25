#!/usr/bin/env node
// Repository-owned stand-in for the agent-browser CLI, for hermetic tests.
// `mcp` speaks MCP over stdio with two fixture tools; every other command
// (session housekeeping) succeeds without touching a real browser.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
if (process.env.FAKE_AGENT_BROWSER_LOG) appendFileSync(process.env.FAKE_AGENT_BROWSER_LOG, JSON.stringify({ args, session: process.env.AGENT_BROWSER_SESSION }) + "\n");
if (args[0] !== "mcp") {
  if (args[0] === "session" && args[1] === "list") process.stdout.write(JSON.stringify({ success: true, data: { sessions: [] } }));
  process.exit(0);
}
const tools = [
  { name: "navigate", description: "Open a URL in the fixture browser.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  { name: "snapshot", description: "Read the fixture page.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return reply(frame.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake-agent-browser", version: "1" } });
  if (frame.method === "tools/list") return reply(frame.id, { tools });
  if (frame.method === "tools/call") {
    if (process.env.FAKE_AGENT_BROWSER_LOG) appendFileSync(process.env.FAKE_AGENT_BROWSER_LOG, JSON.stringify({ call: frame.params.name, arguments: frame.params.arguments }) + "\n");
    return reply(frame.id, { content: [{ type: "text", text: `fixture browser ${frame.params.name} ok session=${process.env.AGENT_BROWSER_SESSION ?? ""}` }] });
  }
  reply(frame.id, {});
});
