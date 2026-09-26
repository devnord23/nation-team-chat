import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import { NationWalletPanel, shortAmount, type EmbeddedWalletStatus } from "./NationWalletPay";
import { approvalChallenge, base64url, fromBase64url } from "@/lib/nation-wallet";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const noop = () => {};
const panel = (status: EmbeddedWalletStatus | null, extra: Partial<Parameters<typeof NationWalletPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(NationWalletPanel, {
    status, symbol: "USDG", token: USDG, amount: "15.123456", disabled: false, busy: null, error: "", copied: false,
    onCreate: noop, onPay: noop, onRefresh: noop, onCopy: noop, ...extra,
  }));
// Nation Team Chat is the only name a person should see.
const FOREIGN = /turnkey|open\s*maus|anthropic|claude|hermes|venice|github/i;

describe("NATION wallet panel", () => {
  it("shows nothing where the wallet is not offered", () => {
    expect(panel(null)).toBe("");
    expect(panel({ available: false, wallet: null })).toBe("");
  });

  it("offers to create a passkey-held wallet", () => {
    const html = panel({ available: true, wallet: null });
    expect(html).toContain("Pay from your NATION wallet");
    expect(html).toContain("Create NATION wallet");
    expect(html).toContain("only a passkey on this device can use");
    expect(html).not.toMatch(FOREIGN);
  });

  it("shows the address, what it holds and the exact payment", () => {
    const html = panel({ available: true, wallet: {
      address: "0x1111111111111111111111111111111111111111", credentialId: "c",
      balances: { eth: "0.002134999", tokens: [{ symbol: "USDG", token: USDG.toLowerCase(), amount: "20.5" }, { symbol: "$NATION", token: "0xc839", amount: "9" }] },
    } });
    expect(html).toContain("0x1111111111111111111111111111111111111111");
    expect(html).toContain("Holds 20.5 USDG and 0.0021 ETH for network fees.");
    expect(html).toContain("Pay 15.123456 USDG from NATION wallet");
    expect(html).toContain("send USDG and a little ETH");
    expect(html).not.toMatch(FOREIGN);
  });

  it("says so when balances cannot be read, and waits while the passkey is asked", () => {
    const wallet = { address: "0x1111111111111111111111111111111111111111", credentialId: "c", balances: null };
    expect(panel({ available: true, wallet })).toContain("Balance unavailable right now.");
    const busy = panel({ available: true, wallet }, { busy: "pay" });
    expect(busy).toContain("Approve with your passkey…");
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Approve with your passkey/);
  });

  it("formats balances briefly", () => {
    expect(shortAmount("12.500000")).toBe("12.5");
    expect(shortAmount("0.000001")).toBe("0");
    expect(shortAmount("7")).toBe("7");
  });
});

describe("passkey approvals", () => {
  it("sign the text of hex(sha256(body)), as the server checks", async () => {
    const body = JSON.stringify({ type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", organizationId: "org" });
    const expected = Buffer.from(createHash("sha256").update(body).digest("hex"), "utf8");
    expect(Buffer.from(await approvalChallenge(body))).toEqual(expected);
  });

  it("encode bytes as unpadded base64url and back", () => {
    const bytes = new Uint8Array([0, 250, 251, 252, 253, 254, 255, 62, 63]);
    expect(base64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    expect(Array.from(fromBase64url(base64url(bytes)))).toEqual(Array.from(bytes));
  });
});
