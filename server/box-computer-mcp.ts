// Turn-scoped Box tools for NATION API, using the same stdio protocol as
// the existing connector proxy. Box ownership and lifecycle stay in the harness.
import { createInterface } from "node:readline";
import { z } from "zod";
import { createControlClient, CONTROL_REFUSAL_PLAIN } from "./control-client.ts";
import { isolatedRemoteCommand, MAX_REMOTE_COMMAND_LENGTH, runCommand, screenshotBox } from "./box.ts";

const boxId = process.env.NATION_BOX_ID ?? "";
const token = process.env.BOX_TOKEN ?? "";
const control = createControlClient();
if (!boxId || !/^[A-Za-z0-9_-]+$/.test(boxId) || !token || !control.configured) throw new Error("Missing turn-scoped Box connection");
const cfg = { box: { token } };
const commandSchema = z.object({ command: z.string().min(1).max(MAX_REMOTE_COMMAND_LENGTH) }).strict();
const tools = [
  { name: "screenshot", description: "Read the current screenshot of this agent's assigned Box desktop. Observe before clicking or typing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "execute", description: "Run a Linux shell command on this agent's assigned Box only. Use xdotool for desktop input (DISPLAY is set), then screenshot to observe results. Commands do not inherit provider credentials.",
    inputSchema: { type: "object", properties: { command: { type: "string", minLength: 1, maxLength: MAX_REMOTE_COMMAND_LENGTH } }, required: ["command"], additionalProperties: false } },
];
const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const error = (id: unknown, message: string) => reply(id, { isError: true, content: [{ type: "text", text: message }] });
async function handle(line: string) {
  const frame = JSON.parse(line);
  if (frame.id === undefined) return;
  if (frame.method === "initialize") return reply(frame.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "nation-box", version: "1" } });
  if (frame.method === "ping") return reply(frame.id, {});
  if (frame.method === "tools/list") return reply(frame.id, { tools });
  if (frame.method !== "tools/call") return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "Unknown method" } }) + "\n");
  const state = await control.state(true);
  if (state.held || state.blockedReason) return error(frame.id, state.blockedReason || CONTROL_REFUSAL_PLAIN);
  try {
    if (frame.params?.name === "screenshot") {
      z.object({}).strict().parse(frame.params.arguments ?? {});
      const shot = await screenshotBox(cfg, "", boxId);
      return reply(frame.id, { content: [{ type: "image", data: shot.png, mimeType: shot.format === "jpeg" ? "image/jpeg" : "image/png" }] });
    }
    if (frame.params?.name !== "execute") return error(frame.id, "Unknown tool");
    const { command } = commandSchema.parse(frame.params.arguments);
    const result = await runCommand(cfg, boxId, isolatedRemoteCommand(command));
    reply(frame.id, { isError: !result.ok, content: [{ type: "text", text: JSON.stringify({
      exitCode: result.exitCode, stdout: result.stdout.slice(-32_000), stderr: result.stderr.slice(-4_000),
    }) }] });
  } catch { error(frame.id, "Box operation failed; inspect its state before retrying."); }
}
let pending = Promise.resolve<unknown>(undefined);
createInterface({ input: process.stdin }).on("line", line => {
  if (line.length > 64 * 1024) { process.exitCode = 1; process.stdin.destroy(); return; }
  pending = pending.then(() => handle(line)).catch(() => { process.exitCode = 1; process.stdin.destroy(); });
});
