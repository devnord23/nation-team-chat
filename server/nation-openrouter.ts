/**
 * Nation OpenRouter integration.
 *
 * OPENROUTER_API_KEY stays server-side only; the client only learns whether
 * free credit is configured (a boolean). NATION_OPENROUTER_MODEL overrides
 * the upstream model; it must not resolve to a Claude / Anthropic slug.
 *
 * VPS env summary (set in /opt/nation-team-chat environment or .env):
 *
 *   OPENROUTER_API_KEY=sk-or-v1-…          # required — shared Nation credit
 *   OPENROUTER_API_URL=https://openrouter.ai/api/v1  # optional override
 *   NATION_OPENROUTER_MODEL=openai/gpt-4o  # optional default model override
 *
 * The `openaiCompat` built-in engine also inherits OPENROUTER_API_KEY via
 * the openai-compat driver's decodeConfig() → process.env fallback.  No
 * extra config.json key is required; setting OPENROUTER_API_KEY is enough
 * for both the nation-openrouter (VPS rail) and openaiCompat (Local VM rail)
 * instances to become available on the same key.
 *
 * Models that cannot be proxied through OpenRouter (true CLI installs that
 * require a local binary — Cursor CLI, Droid CLI, Kimi CLI, Codex CLI,
 * Antigravity CLI) are excluded from the Nation catalog and stay admin-only
 * in the full engine fleet.
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

export interface NationOpenRouterTestResult {
  ok: boolean;
  message: string;
}

/**
 * Admin-only: test the OpenRouter connection by requesting the model list.
 * Never called by non-admin code paths; the key stays server-only.
 */
export async function testOpenRouterConnection(
  env: NodeJS.ProcessEnv = process.env,
): Promise<NationOpenRouterTestResult> {
  const key = (env.OPENROUTER_API_KEY ?? "").trim();
  if (!key) {
    return { ok: false, message: "OPENROUTER_API_KEY is not configured" };
  }
  const baseUrl = openRouterBaseUrl(env);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      return { ok: false, message: `OpenRouter returned HTTP ${res.status}` };
    }
    const data = (await res.json()) as { data?: unknown[] };
    const count = Array.isArray(data?.data) ? data.data.length : 0;
    return { ok: true, message: `Connected — ${count} model${count === 1 ? "" : "s"} available` };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, message: "Request timed out (10 s)" };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
