import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return ({
    state: {
      config: { isProductOwner: false, adminGate: { pinRequired: false } } as Record<string, unknown>,
      instances: [] as any[],
      modelVariantSessions: {},
    },
  });
});
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture.state, refreshInstances: vi.fn(), refreshModels: vi.fn(), dispatch: vi.fn() }),
  api: vi.fn(),
}));
import { ModelPicker } from "./ModelPicker";
import { CloudBackendPicker } from "./CloudBackendPicker";
import { AccessSection } from "./bot-settings/AccessSection";
import { NoEngines } from "./NoEngines";
import { isProductAdmin } from "@/lib/admin-gate";
beforeEach(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("sessionStorage", { getItem: () => "1" });
  fixture.state.config = { isProductOwner: false, adminGate: { pinRequired: false } };
  fixture.state.instances = [];
});
it("renders only NATION controls for a server-confirmed member, even with a forged local unlock", () => {
  const html = [
    renderToStaticMarkup(createElement(ModelPicker, {} as any)),
    renderToStaticMarkup(createElement(CloudBackendPicker, { value: "box", vpsSupported: true, onChange: vi.fn() })),
    renderToStaticMarkup(createElement(AccessSection, {} as any)),
    renderToStaticMarkup(createElement(NoEngines)),
  ].join("\n");
  expect(html).toContain("NATION API");
  expect(html).toContain("NATION Isolated PC");
  expect(html).not.toMatch(/OpenMaus|openrouter|Claude|Anthropic|Grok|xAI|Venice|Hermes|Box|Your engines|github|source code|open source/i);
  // no connector vendor, key entry or per-bot connector configuration for members
  expect(html).not.toMatch(/Composio|API key|project key|Connected apps|Allow this bot to use connected apps/i);
  expect(isProductAdmin({ isProductOwner: false, unlocked: true })).toBe(false);
});

it("mounts the real model picker for a hosted-model workspace member (hostedModelSelection: true)", () => {
  fixture.state.config = { isProductOwner: false, adminGate: { pinRequired: false }, hostedModelSelection: true };
  // With no available instances the picker renders the "no providers" state — the
  // important check is that the interactive picker element is mounted at all, not
  // the static "NATION API" text label that non-hosted members see.
  const bot = {
    id: "bot_1", threadId: "t_1", name: "Scout", title: "", description: "",
    modelSelection: { instanceId: "nation", model: "NATION API" },
    notifications: true, color: "green", unread: false, messages: [],
  };
  const html = renderToStaticMarkup(createElement(ModelPicker, { bot } as any));
  // The interactive picker button (aria-expanded) must be present, not just a static span.
  expect(html).toContain('aria-expanded="false"');
  // Vendor identity must still be suppressed regardless.
  expect(html).not.toMatch(/OpenMaus|Claude|Anthropic|Grok|xAI|openrouter/i);
});
