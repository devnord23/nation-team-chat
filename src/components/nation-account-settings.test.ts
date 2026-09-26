// Settings for someone signed in to their own Nation workspace: their account
// and a way to sign out, their own name, language and tour, billing, and none
// of the operator's controls. A member of a shared desk sees neither the
// operator's controls nor preferences that belong to the desk's owner.
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
  const member = {
    isProductOwner: false as boolean,
    personalWorkspace: true as boolean,
    adminGate: { pinRequired: false },
    profile: { name: "", email: "" },
    language: "",
    onboarding: { completedAt: "", version: 0, reelSeen: false, hintsSeen: [] },
    rooms: { turnTimeoutMinutes: 5 },
    threads: { maxConcurrentPerBot: 2 },
    vps: { configured: false },
    composio: { configured: false },
    tts: { configured: false },
    features: { browser: false, showToolCalls: false, skillAuthoring: false, sharedComputers: false },
    browserProfiles: [],
  };
  return { browserWindow, member, state: { config: member as Record<string, unknown>, appSettingsSection: "general", instances: [], bots: [], groups: [] } };
});
vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn(), track: vi.fn() }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: fixture.state, dispatch: vi.fn(), refreshInstances: vi.fn() }),
  api: vi.fn(() => Promise.resolve({})),
  apiUrl: (path: string) => path,
}));

import { SettingsModal } from "./SettingsModal";
import { AccountCardView } from "./AccountCard";
import { hiddenFromMember } from "@/lib/admin-gate";
import { personalMember, preferencesRoute } from "@/lib/preferences";

const OPERATOR = /Room turns|parallel|Clean up|Diagnostics|People|Backups/i;

beforeEach(() => {
  vi.stubGlobal("window", fixture.browserWindow());
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  fixture.state.config = fixture.member;
});

describe("where preferences are saved", () => {
  it("in one's own workspace, through the narrow route; on a desk, only by its owner", () => {
    expect(preferencesRoute(fixture.member)).toEqual({ path: "/api/workspace/preferences", method: "PATCH" });
    expect(personalMember(fixture.member)).toBe(true);
    expect(preferencesRoute({ ...fixture.member, personalWorkspace: false })).toBeNull();
    expect(preferencesRoute({ isProductOwner: true })).toEqual({ path: "/api/config", method: "PUT" });
    // before the config arrives, nothing is assumed about a member
    expect(personalMember(null)).toBe(false);
  });

  it("People and Backups are the operator's: hidden from a member, never from an owner", () => {
    expect(hiddenFromMember("people", fixture.member)).toBe(true);
    expect(hiddenFromMember("backups", fixture.member)).toBe(true);
    expect(hiddenFromMember("usage", fixture.member)).toBe(false);
    expect(hiddenFromMember("people", { isProductOwner: true })).toBe(false);
    // before the config arrives, and behind a PIN, an owner keeps them as before
    expect(hiddenFromMember("backups", null)).toBe(false);
  });
});

describe("General settings", () => {
  // Group turns, parallel threads, event log cleanup, diagnostics, and the People / Backups sections.
  const OPERATOR_CONTROLS = />(Group turns|Parallel threads|Event log cleanup|Diagnostics|People|Backups)</;

  it("for a member of their own workspace: name, language and the tour, no operator controls", () => {
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).toContain(">Profile<");
    expect(html).toContain(">Language<");
    expect(html).toContain(">Welcome tour<");
    expect(html).toContain("The short introduction to Nation Team Chat");
    expect(html).not.toMatch(/engines/i);
    expect(html).not.toMatch(OPERATOR_CONTROLS);
  });

  it("for a member of a shared desk: nothing that would be refused", () => {
    fixture.state.config = { ...fixture.member, personalWorkspace: false };
    const html = renderToStaticMarkup(createElement(SettingsModal));
    expect(html).not.toMatch(/>(Profile|Language|Welcome tour)</);
    expect(html).not.toMatch(OPERATOR_CONTROLS);
  });

  it("for the owner: everything, as before", () => {
    fixture.state.config = { ...fixture.member, isProductOwner: true, personalWorkspace: false };
    const html = renderToStaticMarkup(createElement(SettingsModal));
    for (const label of ["Profile", "Language", "Group turns", "Parallel threads", "Event log cleanup", "People", "Backups"]) expect(html).toContain(`>${label}<`);
  });
});

describe("account card", () => {
  it("names the signed-in address and offers sign out", () => {
    const html = renderToStaticMarkup(createElement(AccountCardView, { session: { kind: "session", email: "alice@example.test" }, busy: false, failed: false, onSignOut: vi.fn() }));
    expect(html).toContain("Signed in as alice@example.test");
    expect(html).toContain(">Sign out<");
  });

  it("is absent on the owner's own machine", () => {
    expect(renderToStaticMarkup(createElement(AccountCardView, { session: { kind: "loopback" }, busy: false, failed: false, onSignOut: vi.fn() }))).toBe("");
    expect(renderToStaticMarkup(createElement(AccountCardView, { session: null, busy: false, failed: false, onSignOut: vi.fn() }))).toBe("");
  });

  it("uses no operator wording", () => {
    const html = renderToStaticMarkup(createElement(AccountCardView, { session: { kind: "session", email: "alice@example.test" }, busy: true, failed: true, onSignOut: vi.fn() }));
    expect(html).not.toMatch(OPERATOR);
  });
});
