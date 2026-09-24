// Nation-provisioned OpenRouter engine.
//
// Unlike the generic openai-compat driver (access:"custom", user-supplied key),
// this driver is:
//   - access:"subscription" → appears on the VPS rail in the model picker
//   - Server-provisioned from OPENROUTER_API_KEY (no end-user key paste)
//   - No CLI install step — key is pre-configured on the VPS
//   - Curated default catalog of strong models, all non-Claude-branded to
//     regular users (ModelPicker already masks claude/anthropic as "NATION API")
//
// Auto-injected into the instance fleet by instanceConfigs() in config.ts
// whenever OPENROUTER_API_KEY is set and no explicit "nationApi" instance
// overrides it.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";

const DRIVER_KIND = "nation-openrouter";
const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Curated OpenRouter models exposed to Nation users as NATION API.
 * These are pre-seeded so the picker shows strong options immediately;
 * the entry is read-only (no live /models fetch) to keep the catalog
 * predictable. Admins can add any model via the custom text field.
 *
 * Model IDs follow OpenRouter's <provider>/<model-slug> format.
 * Claude/Anthropic rows are intentionally included — ModelPicker already
 * masks them as "NATION API" for non-admin users.
 *
 * CLI-only engines (Cursor CLI, Droid CLI, Codex CLI, Kimi CLI, …) are NOT
 * listed here — they require local install and stay admin-only in the fleet.
 */
export const NATION_OPENROUTER_CATALOG: Array<{ id: string; label: string }> = [
  { id: "moonshotai/kimi-k2",                  label: "Kimi K2"              },
  { id: "openai/gpt-4o",                        label: "GPT-4o"               },
  { id: "openai/gpt-4.1",                       label: "GPT-4.1"              },
  { id: "openai/gpt-4o-mini",                   label: "GPT-4o mini"          },
  { id: "openai/o4-mini",                       label: "o4-mini"              },
  { id: "anthropic/claude-opus-4-5",            label: "Claude Opus"          },
  { id: "anthropic/claude-sonnet-4-5",          label: "Claude Sonnet"        },
  { id: "google/gemini-2.5-pro-preview",        label: "Gemini 2.5 Pro"       },
  { id: "google/gemini-2.5-flash-preview",      label: "Gemini 2.5 Flash"     },
  { id: "deepseek/deepseek-r1",                 label: "DeepSeek R1"          },
  { id: "deepseek/deepseek-chat-v3-0324",       label: "DeepSeek Chat"        },
  { id: "qwen/qwen3-235b-a22b",                 label: "Qwen3 235B"           },
  { id: "x-ai/grok-3-mini-beta",               label: "Grok 3 Mini"          },
  { id: "meta-llama/llama-3.3-70b-instruct",   label: "Llama 3.3 70B"        },
  { id: "mistralai/mistral-large-2411",         label: "Mistral Large"        },
  { id: "nousresearch/hermes-3-llama-3.1-405b:nitro", label: "Hermes 405B"   },
];

const DEFAULT_MODELS: ModelCatalog = {
  default: NATION_OPENROUTER_CATALOG[0]!.id,
  options: NATION_OPENROUTER_CATALOG.map((m) => ({ id: m.id, label: m.label })),
};

export const NationOpenRouterDriver: ProviderDriver<Record<string, never>> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "NATION API",
    supportsMultipleInstances: false,
    access: "subscription",
  },
  models: DEFAULT_MODELS,
  // No install step — OPENROUTER_API_KEY is provisioned server-side.
  install: undefined,
  decodeConfig: () => ({}),
  defaultConfig: () => ({}),

  async create(input) {
    const apiKey =
      input.environment.OPENROUTER_API_KEY ??
      process.env.OPENROUTER_API_KEY ??
      "";
    const apiUrl =
      (input.environment.OPENROUTER_API_URL ?? process.env.OPENROUTER_API_URL ?? "")
        .replace(/\/+$/, "") || "https://openrouter.ai/api/v1";
    const catalog: ModelCatalog = { ...DEFAULT_MODELS };

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl,
      models: () => catalog,
      // Catalog is intentionally fixed (no live fetch) so the model list stays
      // curated and does not expose hundreds of raw OpenRouter entries.
      refreshModels: async () => {},
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        stream_options: stream ? { include_usage: true } : undefined,
      }),
      httpErrorLabel: "NATION API",
      missingKeyError: "NATION API is not configured — set OPENROUTER_API_KEY on the VPS",
      unavailableReason: "NATION API is not configured — set OPENROUTER_API_KEY on the VPS",
      timeoutMs: DEFAULT_TIMEOUT_MS,
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "nation-openrouter.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({
          textLength: text.length,
          reasoningLength: reasoning.length,
          usage,
        }),
      },
    });
  },
};
