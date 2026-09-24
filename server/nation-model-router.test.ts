import { describe, expect, it } from "vitest";
import { classifyTask, modelRouteCatalog, routeModel } from "./nation-model-router.ts";

const catalog = { fast: "openai/gpt-4o-mini", standard: "openai/gpt-4.1", strong: "openai/o4-mini", configured: ["fast", "standard", "strong"] as const };

describe("NATION model routing", () => {
  it("sends simple requests to the fast tier", () => {
    for (const text of ["hi", "Thanks!", "Is this email spam or not: 'You won a prize'", "What's the capital of France?"]) {
      expect(routeModel({ text }, { ...catalog, configured: [...catalog.configured] }).tier, text).toBe("fast");
    }
  });

  it("sends research, ordinary coding and document analysis to the standard tier", () => {
    for (const text of ["Research the top three CRM tools and compare pricing", "Write a function that parses ISO dates", "Summarize this document for the board"]) {
      expect(classifyTask({ text }).tier, text).toBe("standard");
    }
    expect(classifyTask({ text: "Summarize this", attachments: 1 }).tier).toBe("standard");
  });

  it("sends hard coding, architecture, long context and debugging to the strong tier", () => {
    expect(classifyTask({ text: "Design the architecture for a multi-region event store and plan the migration" }).tier).toBe("strong");
    expect(classifyTask({ text: "Why does this crash?\nTraceback (most recent call last):\n  File \"a.py\", line 3" }).tier).toBe("strong");
    expect(classifyTask({ text: "Explain the decision", historyChars: 90_000 }).tier).toBe("strong");
    expect(classifyTask({ text: "Debug the race condition in the job queue" }).tier).toBe("strong");
  });

  it("counts the tools a turn will drive", () => {
    expect(classifyTask({ text: "open the site" }).tier).toBe("fast");
    expect(classifyTask({ text: "open the site", tools: { computer: true } }).tier).toBe("standard");
  });

  it("is deterministic and explains itself", () => {
    const input = { text: "Refactor the billing module and review the tests", attachments: 2, historyChars: 25_000 };
    const first = routeModel(input, { ...catalog, configured: [...catalog.configured] });
    for (let i = 0; i < 20; i++) expect(routeModel(input, { ...catalog, configured: [...catalog.configured] })).toEqual(first);
    expect(first.reasons.length).toBeGreaterThan(0);
  });

  it("offers the next cheaper distinct model as the fallback", () => {
    const c = { ...catalog, configured: [...catalog.configured] };
    expect(routeModel({ text: "Debug the race condition in the job queue" }, c)).toMatchObject({ model: "openai/o4-mini", fallback: "openai/gpt-4.1" });
    expect(routeModel({ text: "Write a function that parses dates" }, c)).toMatchObject({ model: "openai/gpt-4.1", fallback: "openai/gpt-4o-mini" });
    expect(routeModel({ text: "hi" }, c).fallback).toBeUndefined();
  });

  it("uses only the operator's allowed catalog and keeps one model when none is configured", () => {
    expect(modelRouteCatalog({})).toMatchObject({ fast: "openai/gpt-4o-mini", standard: "openai/gpt-4o-mini", strong: "openai/gpt-4o-mini", configured: [] });
    expect(modelRouteCatalog({ NATION_OPENROUTER_MODEL: "openai/gpt-4.1" }).strong).toBe("openai/gpt-4.1");
    expect(modelRouteCatalog({ NATION_MODEL_FAST: "openai/gpt-4o-mini", NATION_MODEL_STRONG: "openai/o4-mini" }))
      .toMatchObject({ fast: "openai/gpt-4o-mini", standard: "openai/gpt-4o-mini", strong: "openai/o4-mini", configured: ["fast", "strong"] });
    // refused like NATION_OPENROUTER_MODEL: provider-branded and malformed slugs
    expect(modelRouteCatalog({ NATION_MODEL_STRONG: "anthropic/claude-opus-4-5" }).configured).toEqual([]);
    expect(modelRouteCatalog({ NATION_MODEL_STRONG: "not a model; rm -rf /" }).configured).toEqual([]);
  });
});
