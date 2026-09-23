import { describe, expect, it } from "vitest";

import { cloudVpsPublicStatus } from "./cloud-vps-from-env.ts";

describe("cloudVpsPublicStatus", () => {
  it("is not configured when env is empty", () => {
    const status = cloudVpsPublicStatus({});
    expect(status.configured).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.host).toBeNull();
    expect(status.user).toBeNull();
    expect(status.missing).toContain("VPS_HOST");
    expect(status.missing).toContain("VPS_USER");
  });

  it("is configured but not ready when host + user are set but no key", () => {
    const status = cloudVpsPublicStatus({ VPS_HOST: "vps.example.com", VPS_USER: "deploy" });
    expect(status.configured).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.missing).toContain("VPS_SSH_KEY_PATH (or VPS_SSH_KEY)");
    expect(status.authSecretPresent).toBe(false);
  });

  it("is ready when host + user + VPS_SSH_KEY_PATH are set", () => {
    const status = cloudVpsPublicStatus({
      VPS_HOST: "vps.example.com",
      VPS_USER: "deploy",
      VPS_SSH_KEY_PATH: "/home/user/.ssh/nation_vps",
    });
    expect(status.configured).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.missing).toHaveLength(0);
    expect(status.authSecretPresent).toBe(true);
  });

  it("is ready when host + user + VPS_SSH_KEY (inline content) are set", () => {
    const status = cloudVpsPublicStatus({
      VPS_HOST: "vps.example.com",
      VPS_USER: "deploy",
      VPS_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC123\n-----END OPENSSH PRIVATE KEY-----",
    });
    expect(status.configured).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.missing).toHaveLength(0);
    expect(status.authSecretPresent).toBe(true);
  });

  it("accepts either VPS_SSH_KEY_PATH or VPS_SSH_KEY — both being set is also fine", () => {
    const status = cloudVpsPublicStatus({
      VPS_HOST: "vps.example.com",
      VPS_USER: "deploy",
      VPS_SSH_KEY_PATH: "/home/user/.ssh/id_rsa",
      VPS_SSH_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
    });
    expect(status.ready).toBe(true);
    expect(status.authSecretPresent).toBe(true);
  });

  it("is NOT ready when only VPS_PASSWORD is set (password-only is not accepted)", () => {
    const status = cloudVpsPublicStatus({
      VPS_HOST: "vps.example.com",
      VPS_USER: "deploy",
      VPS_AUTH_METHOD: "password",
      VPS_PASSWORD: "s3cret",
    });
    expect(status.configured).toBe(true);
    expect(status.ready).toBe(false);
    expect(status.authSecretPresent).toBe(false);
    // Still requires a key
    expect(status.missing.some((m) => m.includes("VPS_SSH_KEY"))).toBe(true);
  });

  it("respects VPS_SSH_PORT", () => {
    const status = cloudVpsPublicStatus({
      VPS_HOST: "vps.example.com",
      VPS_USER: "deploy",
      VPS_SSH_KEY_PATH: "/keys/id",
      VPS_SSH_PORT: "2222",
    });
    expect(status.port).toBe(2222);
  });

  it("defaults port to 22 when VPS_SSH_PORT is absent or invalid", () => {
    expect(cloudVpsPublicStatus({ VPS_HOST: "h", VPS_USER: "u" }).port).toBe(22);
    expect(cloudVpsPublicStatus({ VPS_HOST: "h", VPS_USER: "u", VPS_SSH_PORT: "abc" }).port).toBe(22);
  });

  it("reads VPS_LABEL for display", () => {
    const status = cloudVpsPublicStatus({
      VPS_HOST: "vps.example.com",
      VPS_USER: "deploy",
      VPS_SSH_KEY_PATH: "/keys/id",
      VPS_LABEL: "nation-cloud-vps",
    });
    expect(status.label).toBe("nation-cloud-vps");
  });

  it("uses 'cloud-vps' as default label", () => {
    const status = cloudVpsPublicStatus({ VPS_HOST: "h", VPS_USER: "u" });
    expect(status.label).toBe("cloud-vps");
  });

  it("never echoes VPS_SSH_KEY or VPS_SSH_KEY_PATH content to the public status", () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET\n-----END OPENSSH PRIVATE KEY-----";
    const status = cloudVpsPublicStatus({
      VPS_HOST: "vps.example.com",
      VPS_USER: "deploy",
      VPS_SSH_KEY: privateKey,
    });
    const json = JSON.stringify(status);
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain(privateKey);
  });
});
