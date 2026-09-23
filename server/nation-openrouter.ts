/**
 * Nation OpenRouter integration.
 *
 * OPENROUTER_API_KEY stays server-side only; the client only learns whether
 * free credit is configured (a boolean). NATION_OPENROUTER_MODEL overrides
 * the upstream model; it must not resolve to a Claude / Anthropic slug.
 */

export const NATION_DEFAULT_MODEL = "openai/gpt-4o-mini";

/** Slugs whose presence in the model string indicates a Claude/Anthropic model. */
const CLAUDE_ANTHROPIC_PATTERNS = [
  /^claude[/-]/i,
  /^anthropic\//i,
  /\/claude[/-]/i,
  /anthropic/i,
];

export function isClaudeOrAnthropicSlug(model: string): boolean {
  return CLAUDE_ANTHROPIC_PATTERNS.some((pattern) => pattern.test(model));
}

/** Resolve the effective upstream model, rejecting prohibited slugs. */
export function resolveNationModel(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.NATION_OPENROUTER_MODEL ?? "").trim();
  if (!override) return NATION_DEFAULT_MODEL;
  if (isClaudeOrAnthropicSlug(override)) {
    // Silently fall back to default rather than hard-crashing the server.
    return NATION_DEFAULT_MODEL;
  }
  return override;
}

export interface NationOpenRouterStatus {
  /** True when OPENROUTER_API_KEY is set — client learns the boolean only. */
  configured: boolean;
  /** The effective upstream model id; never a Claude/Anthropic slug. */
  model: string;
}

/** Public status sent to the client in /api/config. Key is never returned. */
export function nationOpenRouterStatus(env: NodeJS.ProcessEnv = process.env): NationOpenRouterStatus {
  const key = (env.OPENROUTER_API_KEY ?? "").trim();
  return {
    configured: key.length > 0,
    model: resolveNationModel(env),
  };
}

/** Base URL for the OpenRouter API (can be overridden via OPENROUTER_API_URL). */
export function openRouterBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENROUTER_API_URL ?? "").trim() || "https://openrouter.ai/api/v1";
}
