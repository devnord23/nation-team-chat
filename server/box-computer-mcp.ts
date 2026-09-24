// Turn-scoped Box tools for NATION API. Reuse Box ownership/lifecycle and
// command isolation; model calls still pass through the normal approval gate.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createControlClient, CONTROL_REFUSAL_PLAIN } from "./control-client.ts";
import { isolatedRemoteCommand, MAX_REMOTE_COMMAND_LENGTH, runCommand, screenshotBox } from "./box.ts";

const boxId = process.env.NATION_BOX_ID ?? "";
const token = process.env.BOX_TOKEN ?? "";
const control = createControlClient();
if (!boxId || !/^[A-Za-z0-9_-]+$/.test(boxId) || !token || !control.configured) {
  throw new Error("Missing turn-scoped Box connection");
}
const cfg = { box: { token } };
const server = new McpServer({ name: "nation-box", version: "1.0.0" });
const guarded = async (action: () => Promise<{ content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean }>) => {
  const state = await control.state(true);
  if (state.held || state.blockedReason) return { isError: true, content: [{ type: "text" as const, text: state.blockedReason || CONTROL_REFUSAL_PLAIN }] };
  try { return await action(); }
  catch { return { isError: true, content: [{ type: "text" as const, text: "Box operation failed; inspect its state before retrying." }] }; }
};
server.registerTool("screenshot", {
  description: "Read the current screenshot of this agent's assigned Box desktop. Observe before clicking or typing.",
  inputSchema: {},
}, async () => guarded(async () => {
  const frame = await screenshotBox(cfg, "", boxId);
  return { content: [{ type: "image" as const, data: frame.png, mimeType: frame.format === "jpeg" ? "image/jpeg" : "image/png" }] };
}));
server.registerTool("execute", {
  description: "Run a Linux shell command on this agent's assigned Box only. Desktop input is available with xdotool (DISPLAY is set). Use screenshot to observe results. No provider credentials are inherited by the command.",
  inputSchema: { command: z.string().min(1).max(MAX_REMOTE_COMMAND_LENGTH) },
}, async ({ command }) => guarded(async () => {
  const result = await runCommand(cfg, boxId, isolatedRemoteCommand(command));
  return { isError: !result.ok, content: [{ type: "text" as const, text: JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout.slice(-32_000), stderr: result.stderr.slice(-4_000) }) }] };
}));
await server.connect(new StdioServerTransport());
