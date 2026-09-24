import { publicError } from "../shared/public-error.ts";

export const PUBLIC_MODEL_SELECTION = Object.freeze({ instanceId: "nation", model: "NATION API" });
const PRIVATE_KEYS = new Set([
  "driverKind", "providerKind", "engineName", "providerName", "lastInstanceId",
  "cwd", "sshAlias", "image_ref", "base_image_ref", "driver_version", "container_name", "container_id", "image_id",
  "lastModel", "resumeCursors", "modelVariants", "nativeSessionId", "sessionConfigResult", "raw", "sessionId",
]);

/** One projection for HTTP, live SSE and replay. Never mutate stored records.
 * User-authored text and normal work outputs are deliberately preserved. */
export function publicResponse(value: unknown, admin = false): unknown {
  if (typeof value === "string") return value.replace(/openmausbot:\/\/thread\//gi, "nation://thread/");
  if (Array.isArray(value)) return value.map(item => publicResponse(item, admin));
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const failedTool = input.ok === false;
  const runtimeError = input.type === "runtime.error" || input.synthetic === true;
  for (const [key, item] of Object.entries(input)) {
    if (key === "runOn" && item === "maus") { out[key] = "nation"; continue; }
    if (key === "format" && typeof item === "string" && /^openmaus\.(backup|package|team)$/.test(item)) { out[key] = item.replace(/^openmaus\./, "nation."); continue; }
    if (runtimeError && key === "raw") continue;
    if (runtimeError && ["message", "text", "delta"].includes(key) && typeof item === "string") out[key] = publicError(item);
    else if (["error", "problem", "reason"].includes(key) && typeof item === "string") out[key] = publicError(item);
    else if (failedTool && ["name", "output", "detail", "summary", "input"].includes(key) && typeof item === "string") out[key] = publicError(item);
    else if (failedTool && ["outputPath", "stack", "stderr"].includes(key)) continue;
    else if (!admin && input.type === "session.model-variants" && key === "variants") out[key] = { options: [] };
    else if (!admin && key === "name" && typeof item === "string" && ("ok" in input)) out[key] = publicError(item);
    else if (!admin && key === "modelSelection") out[key] = { ...PUBLIC_MODEL_SELECTION };
    else if (!admin && PRIVATE_KEYS.has(key)) continue;
    else if (!admin && ["model", "modelId", "provider", "engine", "instanceId", "providerInstanceId", "modelName"].includes(key) && typeof item === "string") {
      out[key] = ["instanceId", "providerInstanceId"].includes(key) ? "nation" : "NATION API";
    } else out[key] = publicResponse(item, admin);
  }
  return out;
}
