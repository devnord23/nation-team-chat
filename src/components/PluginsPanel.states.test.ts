import { describe, expect, it } from "vitest";
import { connectorActionLabel, connectorAppState, connectorBackendState } from "./PluginsPanel";

describe("connected-app states", () => {
  it("never reports a healthy backend as unconfigured", () => {
    expect(connectorBackendState({ phase: "loading", configured: false })).toBe("checking");
    expect(connectorBackendState({ phase: "ready", configured: true })).toBe("ready");
    expect(connectorBackendState({ phase: "ready", configured: false })).toBe("unavailable");
    // a failed request is not a configuration verdict
    expect(connectorBackendState({ phase: "error", configured: false, errorStatus: 502 })).toBe("unreachable");
    expect(connectorBackendState({ phase: "error", configured: false })).toBe("unreachable");
    expect(connectorBackendState({ phase: "error", configured: false, errorStatus: 403 })).toBe("signin");
  });

  it("names each app's own state", () => {
    const gmail = { noAuth: false };
    expect(connectorAppState(gmail, undefined)).toBe("not-connected");
    expect(connectorAppState(gmail, { connected: false, status: "not_connected", accounts: [] })).toBe("not-connected");
    expect(connectorAppState(gmail, { connected: false, pending: true, status: "INITIATED", accounts: [{ id: "ca_1", status: "INITIATED" }] })).toBe("pending");
    expect(connectorAppState(gmail, { connected: true, status: "ACTIVE", accounts: [{ id: "ca_1", status: "ACTIVE" }] })).toBe("connected");
    expect(connectorAppState(gmail, { connected: false, status: "EXPIRED", accounts: [{ id: "ca_1", status: "EXPIRED" }] })).toBe("failed");
    expect(connectorAppState({ noAuth: true }, undefined)).toBe("included");
  });

  it("offers Connect, Reconnect after an expired sign-in, and Add account once connected", () => {
    const base = { busy: false, included: false, canContinue: false, hasAccounts: false, failed: false };
    expect(connectorActionLabel("ready", base)).toBe("Connect");
    expect(connectorActionLabel("ready", { ...base, failed: true, hasAccounts: true })).toBe("Reconnect");
    expect(connectorActionLabel("ready", { ...base, hasAccounts: true })).toBe("Add account");
  });
});
