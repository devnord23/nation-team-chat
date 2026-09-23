import { describe, expect, it } from "vitest";

import {
  NATION_DEFAULT_MODEL,
  isClaudeOrAnthropicSlug,
  nationOpenRouterStatus,
  openRouterBaseUrl,
  resolveNationModel,
  testOpenRouterConnection,
} from "./nation-openrouter.ts";

describe("NATION_DEFAULT_MODEL", () => {
  it("is openai/gpt-4o-mini", () => {
    expect(NATION_DEFAULT_MODEL).toBe("openai/gpt-4o-mini");
  });
});

describe("isClaudeOrAnthropicSlug", () => {
  it("rejects claude-* slugs", () => {
    expect(isClaudeOrAnthropicSlug("claude-3-5-sonnet-20241022")).toBe(true);
    expect(isClaudeOrAnthropicSlug("claude-opus-4")).toBe(true);
    expect(isClaudeOrAnthropicSlug("claude/haiku")).toBe(true);
  });

  it("rejects anthropic/* slugs", () => {
    expect(isClaudeOrAnthropicSlug("anthropic/claude-3-5-sonnet")).toBe(true);
    expect(isClaudeOrAnthropicSlug("anthropic/any-model")).toBe(true);
  });

  it("allows openai/* slugs", () => {
    expect(isClaudeOrAnthropicSlug("openai/gpt-4o-mini")).toBe(false);
    expect(isClaudeOrAnthropicSlug("openai/gpt-4o")).toBe(false);
  });

  it("allows other provider slugs", () => {
    expect(isClaudeOrAnthropicSlug("meta-llama/llama-3.3-70b-instruct")).toBe(false);
    expect(isClaudeOrAnthropicSlug("mistralai/mistral-7b")).toBe(false);
    expect(isClaudeOrAnthropicSlug("google/gemini-flash")).toBe(false);
  });
});

describe("resolveNationModel", () => {
  it("returns default when NATION_OPENROUTER_MODEL is unset", () => {
    expect(resolveNationModel({})).toBe(NATION_DEFAULT_MODEL);
  });

  it("returns default when NATION_OPENROUTER_MODEL is empty", () => {
    expect(resolveNationModel({ NATION_OPENROUTER_MODEL: "" })).toBe(NATION_DEFAULT_MODEL);
    expect(resolveNationModel({ NATION_OPENROUTER_MODEL: "   " })).toBe(NATION_DEFAULT_MODEL);
  });

  it("uses NATION_OPENROUTER_MODEL override when set to a non-anthropic model", () => {
    expect(resolveNationModel({ NATION_OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-instruct" }))
      .toBe("meta-llama/llama-3.3-70b-instruct");
    expect(resolveNationModel({ NATION_OPENROUTER_MODEL: "openai/gpt-4o" }))
      .toBe("openai/gpt-4o");
  });

  it("falls back to default when override is a Claude slug", () => {
    expect(resolveNationModel({ NATION_OPENROUTER_MODEL: "claude-3-5-sonnet-20241022" }))
      .toBe(NATION_DEFAULT_MODEL);
    expect(resolveNationModel({ NATION_OPENROUTER_MODEL: "anthropic/claude-3-opus" }))
      .toBe(NATION_DEFAULT_MODEL);
  });
});

describe("nationOpenRouterStatus", () => {
  it("reports unconfigured when key is absent", () => {
    const status = nationOpenRouterStatus({});
    expect(status.configured).toBe(false);
    expect(status.model).toBe(NATION_DEFAULT_MODEL);
  });

  it("reports configured when OPENROUTER_API_KEY is set", () => {
    const status = nationOpenRouterStatus({ OPENROUTER_API_KEY: "sk-or-test-key" });
    expect(status.configured).toBe(true);
    expect(status.model).toBe(NATION_DEFAULT_MODEL);
  });

  it("never exposes the key in the status object", () => {
    const status = nationOpenRouterStatus({ OPENROUTER_API_KEY: "sk-or-secret" });
    const json = JSON.stringify(status);
    expect(json).not.toContain("sk-or-secret");
  });

  it("uses NATION_OPENROUTER_MODEL override in status", () => {
    const status = nationOpenRouterStatus({
      OPENROUTER_API_KEY: "sk-or-key",
      NATION_OPENROUTER_MODEL: "meta-llama/llama-3.3-70b-instruct",
    });
    expect(status.model).toBe("meta-llama/llama-3.3-70b-instruct");
  });

  it("falls back to default model when override is an Anthropic slug", () => {
    const status = nationOpenRouterStatus({
      OPENROUTER_API_KEY: "sk-or-key",
      NATION_OPENROUTER_MODEL: "claude-3-5-sonnet-20241022",
    });
    expect(status.model).toBe(NATION_DEFAULT_MODEL);
  });
});

describe("openRouterBaseUrl", () => {
  it("returns the default OpenRouter URL when env var is absent", () => {
    expect(openRouterBaseUrl({})).toBe("https://openrouter.ai/api/v1");
  });

  it("uses OPENROUTER_API_URL override when set", () => {
    expect(openRouterBaseUrl({ OPENROUTER_API_URL: "https://custom.example.com/api/v1" }))
      .toBe("https://custom.example.com/api/v1");
  });
});

describe("testOpenRouterConnection", () => {
  it("returns not-ok when OPENROUTER_API_KEY is absent", async () => {
    const result = await testOpenRouterConnection({});
    expect(result.ok).toBe(false);
    expect(result.message).toContain("OPENROUTER_API_KEY");
  });
});
