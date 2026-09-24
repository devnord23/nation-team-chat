import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  return { state: { config: { isProductOwner: false, imageGen: { configured: true }, tts: { configured: true } } } };
});
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture.state, dispatch: vi.fn(), refreshInstances: vi.fn() }),
  api: vi.fn(),
}));
import { ModelPicker } from "./ModelPicker";
import { VoiceSettings } from "./VoiceSettings";
import { AvatarImageGenerator } from "./AvatarImageGenerator";
import { NoEngines } from "../NoEngines";
import { NationAdminPage } from "../NationAdminPage";
beforeEach(() => { vi.stubGlobal("window", {}); fixture.state.config.isProductOwner = false; });
it.each([false, true])("offers only server-managed API controls when owner=%s", owner => {
  fixture.state.config.isProductOwner = owner;
  const html = [
    renderToStaticMarkup(createElement(ModelPicker, { bot: {} as any })),
    renderToStaticMarkup(createElement(VoiceSettings, { bot: {} as any, onPatch: vi.fn() })),
    renderToStaticMarkup(createElement(AvatarImageGenerator, {
      botLabel: "Navigator", disabled: false, generating: false, onGenerate: vi.fn(), onSavingChange: vi.fn(),
    })),
    renderToStaticMarkup(createElement(NoEngines)),
  ].join("\n");
  expect(html).toContain("NATION API");
  expect(html).toContain("Generate avatar");
  expect(html).not.toMatch(/type="password"|API key|Install|Sign in|Claude|Anthropic|Grok|xAI|Your engines/i);
});
it("keeps owner administration inaccessible to members", () => {
  const html = renderToStaticMarkup(createElement(NationAdminPage));
  expect(html).toContain("Admin access required");
  expect(html).not.toContain("Test connection");
});
it("keeps the owner API status without legacy setup tabs", () => {
  fixture.state.config.isProductOwner = true;
  const html = renderToStaticMarkup(createElement(NationAdminPage));
  expect(html).toContain("NATION API");
  expect(html).not.toMatch(/Keys &amp; Integrations|API Keys|Your engines|type="password"/);
});
