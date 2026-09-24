// Turn-scoped web tools for NATION agents, over the same stdio protocol as
// the other chat-runtime MCP servers. This process holds only a per-turn
// capability: the search credential, the reader's address checks and the
// credit metering all stay in the harness behind /api/internal/web/*.
import { createInterface } from "node:readline";

const harness = process.env.OMB_HARNESS_URL ?? "";
const token = process.env.OMB_WEB_TOKEN ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(harness) || !token) throw new Error("Missing turn-scoped web tools connection");

const tools = [
  {
    name: "search",
    description: "Search the web. Returns titles, links and short snippets (and sometimes a summary) for current information. Follow up with web_read to read a result in full.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 400, description: "What to search for." },
        count: { type: "integer", minimum: 1, maximum: 10, description: "How many results (default 8)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read",
    description: "Read a public web page as plain text (the page's own words, markup removed). Use it for a link from web_search or one the person gave you. Pages that need a login or scripts may need the browser instead.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", pattern: "^https?://", maxLength: 2000, description: "Full http(s) address." } },
      required: ["url"],
      additionalProperties: false,
    },
  },
];

const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const text = (id: unknown, body: string, isError = false) => reply(id, { isError, content: [{ type: "text", text: body }] });

async function handle(line: string) {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return reply(frame.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nation-web", version: "1" } });
  if (frame.method === "ping") return reply(frame.id, {});
  if (frame.method === "tools/list") return reply(frame.id, { tools });
  if (frame.method !== "tools/call") {
    return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unknown method" } }) + "\n");
  }
  const name = frame.params?.name;
  if (name !== "search" && name !== "read") return text(frame.id, "Unknown tool", true);
  try {
    const response = await fetch(`${harness}/api/internal/web/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(frame.params?.arguments ?? {}),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json().catch(() => ({})) as { error?: string; result?: unknown };
    if (!response.ok) return text(frame.id, body.error ?? "Web tools are temporarily unavailable.", true);
    return text(frame.id, JSON.stringify(body.result));
  } catch {
    return text(frame.id, "Web tools are temporarily unavailable.", true);
  }
}

let pending = Promise.resolve<unknown>(undefined);
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.length > 64 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
  pending = pending.then(() => handle(line)).catch(() => { process.exitCode = 1; process.stdin.destroy(); });
});
