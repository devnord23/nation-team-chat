/** Public errors contain an action, never infrastructure diagnostics. */
const PRIVATE_DETAIL = /open\s*maus(?:bot|mobile)?|\bmaus\b|milind-soni|open\s*webui|opengrokbot|claude|anthropic|grok|\bxai\b|x-ai|venice|openrouter|hermes|codex|gemini|deepseek|qwen|elevenlabs|chatterbox|fish audio|github|source code|open[- ]source|(?:https?|ssh|file):\/\/|(?:[A-Z]:\\|\/(?:root|home|Users|tmp|var|opt|workspace|etc|srv|usr|mnt|data)\/)|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|\bat\s+\S+\s*\([^)]*:\d+|\b(?:ENOENT|EACCES|ECONNREFUSED|stack trace)\b/i;

export function publicError(value: unknown): string {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message || PRIVATE_DETAIL.test(message) || message.length > 350 || /\n/.test(message)) {
    return "NATION couldn't complete this request. Please try again or contact support.";
  }
  return message;
}
