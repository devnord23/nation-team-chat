import { describe, expect, it } from "vitest";

import {
  isAdminOnlySettingsSection,
  isProductAdmin,
} from "./admin-gate";

describe("ADMIN_ONLY_SETTINGS_SECTIONS — computer and connections", () => {
  it("marks the computer settings section as admin-only", () => {
    expect(isAdminOnlySettingsSection("computer")).toBe(true);
  });

  it("marks the connections settings section as admin-only", () => {
    expect(isAdminOnlySettingsSection("connections")).toBe(true);
  });

  it("marks experimental and workspaces as admin-only", () => {
    expect(isAdminOnlySettingsSection("experimental")).toBe(true);
    expect(isAdminOnlySettingsSection("workspaces")).toBe(true);
  });

  it("does not mark regular user sections as admin-only", () => {
    for (const id of ["general", "appearance", "usage", "people", "backups", "companion"]) {
      expect(isAdminOnlySettingsSection(id), id).toBe(false);
    }
  });
});

describe("isProductAdmin — computer gate scenarios", () => {
  it("denies when server says isProductOwner is false", () => {
    expect(isProductAdmin({ isProductOwner: false })).toBe(false);
    expect(isProductAdmin({ isProductOwner: false, remoteClient: false, pinRequired: false })).toBe(false);
  });

  it("denies for remote clients even when isProductOwner is true", () => {
    expect(isProductAdmin({ remoteClient: true, isProductOwner: true })).toBe(false);
  });

  it("allows when server confirms owner and no PIN is required", () => {
    expect(isProductAdmin({ isProductOwner: true })).toBe(true);
    expect(isProductAdmin({ isProductOwner: true, pinRequired: false })).toBe(true);
  });

  it("requires session unlock when PIN is required, even for confirmed owner", () => {
    expect(isProductAdmin({ isProductOwner: true, pinRequired: true, unlocked: false })).toBe(false);
    expect(isProductAdmin({ isProductOwner: true, pinRequired: true, unlocked: true })).toBe(true);
  });

  it("falls back to false before the first /api/config response arrives", () => {
    expect(isProductAdmin({})).toBe(false);
    expect(isProductAdmin({ remoteClient: false })).toBe(false);
  });
});
