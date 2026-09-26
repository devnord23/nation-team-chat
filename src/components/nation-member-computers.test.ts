// A server-confirmed member never sees desk setup: no Local VM section in
// Settings, no Box / SSH / "not configured" copy, and a Computer panel that
// explains instead of listing choices that are all "Unavailable here".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const noop = () => {};
  const browserWindow = () => ({
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    location: { pathname: "/swarm/", search: "", hash: "" },
  });
  vi.stubGlobal("window", browserWindow());
  vi.stubGlobal("location", browserWindow().location);
  return {
    browserWindow,
    state: {
      // exactly what configForAccess() sends a client session: no box, no localVm
      config: {
        isProductOwner: false as boolean,
        adminGate: { pinRequired: false },
        profile: { name: "", email: "" },
        language: "",
        onboarding: { completedAt: "", version: 0, reelSeen: false, hintsSeen: [] },
        rooms: { turnTimeoutMinutes: 5 },
        threads: { maxConcurrentPerBot: 2 },
        vps: { configured: true },
        composio: { configured: false },
        tts: { configured: false },
        features: { browser: false, showToolCalls: false, skillAuthoring: false, sharedComputers: false },
        browserProfiles: [],
      } as Record<string, unknown>,
      appSettingsSection: "computer",
      instances: [],
      bots: [],
      groups: [],
    },
  };
});
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn(), track: vi.fn() }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture.state, dispatch: vi.fn(), refreshInstances: vi.fn() }),
  api: vi.fn(),
  apiUrl: (path: string) => path,
}));

import { ComputerPanel } from "./ComputerPanel";
import { SettingsModal } from "./SettingsModal";
import { isAdminOnlySettingsSection, isProductAdmin } from "@/lib/admin-gate";

const DESK_SETUP = /\bBox\b|SSH|Local VM|Unavailable here|not configured|VPS inventory|ascii\.dev|Docker/i;
const bot = { id: "bot_1", name: "Scout", threadId: "thread_1", modelSelection: { instanceId: "nation", model: "NATION API" } } as never;

beforeEach(() => {
  vi.stubGlobal("window", fixture.browserWindow());
  vi.stubGlobal("sessionStorage", { getItem: () => "1", setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
});

describe("member session", () => {
  it("treats Local VM as an owner/admin-only Settings section, even with a forged local unlock", () => {
    expect(isAdminOnlySettingsSection("computer")).toBe(true);
    expect(isProductAdmin({ isProductOwner: false, unlocked: true })).toBe(false);
  });

  it("does not render the Local VM section or its label, even when it was the requested section", () => {
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).not.toMatch(DESK_SETUP);
    expect(html).not.toMatch(/VPS computers/);
  });

  it("shows a NATION explanation in the Computer panel instead of desk setup", () => {
    const html = renderToStaticMarkup(createElement(ComputerPanel, { bot }));
    expect(html).toContain('data-testid="member-computer"');
    expect(html).toContain("Your workspace owner runs the NATION desks");
    expect(html).toContain("Scout");
    expect(html).not.toMatch(DESK_SETUP);
    expect(html).not.toMatch(/OpenMaus|Claude|Anthropic|Hermes|Venice|Grok/i);
  });

  it("still shows the owner the Local VM section with its VPS desk inventory", () => {
    const member = fixture.state.config;
    fixture.state.config = { ...member, isProductOwner: true, box: { configured: false }, localVm: { mode: "shared", maxInstances: 1 } };
    try {
      const html = renderToStaticMarkup(createElement(SettingsModal));
      expect(html).toContain("Local VM");
      expect(html).toContain("Self-hosted VPS computers");
    } finally {
      fixture.state.config = member;
    }
  });
});
