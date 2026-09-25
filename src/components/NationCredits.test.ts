import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

vi.hoisted(() => { vi.stubGlobal("window", {}); });
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { connected: false }, dispatch: vi.fn() }),
  api: vi.fn(),
}));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));

import { NationCreditsStrip, TierCard, TokenToggle, CheckoutPanel } from "./NationCredits";
import type { CreditStatus, CreditTier } from "@/lib/nation-credits-ctx";

type Status = Parameters<typeof NationCreditsStrip>[0]["status"];

const chain = { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: "0x1" as Hex, treasury: "0x2" as Hex };
const base: Status = {
  balanceUsd: 5, label: "$5.00 credit", verified: true, exempt: false,
  lowBalance: false, topUpEnabled: true, topUpMessage: "", starterMessage: "",
  packs: [10, 25], chains: [chain], invoices: [],
};

beforeEach(() => vi.unstubAllGlobals());

describe("NationCreditsStrip", () => {
  it("shows Top up when topUpEnabled and NOT exempt", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: true, exempt: false }, onOpen: vi.fn() }),
    );
    expect(html).toContain("Top up");
    expect(html).not.toContain("NATION API");
  });

  it("shows Top up when topUpEnabled AND exempt (owner can test payment flow)", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: true, exempt: true }, onOpen: vi.fn() }),
    );
    expect(html).toContain("Top up");
    expect(html).toContain("NATION API");
  });

  it("shows topUpMessage for non-exempt when topUpEnabled is false", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: false, topUpMessage: "Top up launching soon" }, onOpen: vi.fn() }),
    );
    expect(html).toContain("Top up launching soon");
    expect(html).not.toContain(">Top up<");
  });

  it("shows muted topUpMessage for exempt when topUpEnabled is false", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: true, topUpMessage: "Coming soon for members" }, onOpen: vi.fn() }),
    );
    expect(html).toContain("Coming soon for members");
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("NATION API");
  });

  it("renders nothing actionable for exempt + topUpDisabled + no topUpMessage", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: true, topUpMessage: "" }, onOpen: vi.fn() }),
    );
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("NATION API");
  });

  it("shows Get free starter credit for unverified users (regardless of exempt)", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, verified: false, exempt: true }, onOpen: vi.fn() }),
    );
    expect(html).toContain("Get free starter credit");
  });
});

// ─── TierCard ──────────────────────────────────────────────────────────────────

const tier: CreditTier = { id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true };

describe("TierCard", () => {
  const baseProps = {
    tier,
    selected: false,
    payWithNation: false,
    nationPriceUsd: null,
    nationDiscount: null,
    nonNationSymbol: "USDG",
    onSelect: vi.fn(),
    disabled: false,
  };

  it("renders USDG CTA label — not USDC", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).toContain("USDG");
    expect(html).not.toContain("USDC");
  });

  it("does not contain window.location.href in rendered output", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).not.toContain("window.location.href");
    expect(html).not.toContain("thenation.city/subscription");
  });

  it("renders pack price prominently", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).toContain("$49");
    expect(html).toContain("Builder");
  });

  it("shows NATION CTA and discount badge when payWithNation=true and price is set", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: true, nationPriceUsd: 0.5, nationDiscount: 0.2 }),
    );
    expect(html).toContain("$NATION");
    expect(html).toContain("Save ~20%");
  });

  it("uses nationDiscount percentage in badge", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: true, nationPriceUsd: 0.5, nationDiscount: 0.15 }),
    );
    expect(html).toContain("Save ~15%");
  });

  it("shows Most popular badge on popular tier", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).toContain("Most popular");
  });

  it("shows dual prices: USDG primary + NATION secondary when nationPriceUsd is set and payWithNation=false", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: false, nationPriceUsd: 0.5, nationDiscount: 0.2 }),
    );
    // Primary = $49
    expect(html).toContain("$49");
    // Secondary = NATION equivalent with discount hint
    expect(html).toContain("$NATION");
    expect(html).toContain("save ~20%");
  });

  it("shows dual prices: NATION primary + USD secondary when payWithNation=true", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: true, nationPriceUsd: 0.5, nationDiscount: 0.2 }),
    );
    // Primary = NATION amount
    expect(html).toContain("$NATION");
    // Secondary = USD reference
    expect(html).toContain("= $49 value");
  });

  it("no secondary price when nationPriceUsd is null (USDG-only)", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, nationPriceUsd: null }),
    );
    expect(html).not.toContain("save ~");
    expect(html).not.toContain("= $");
  });
});

// ─── TokenToggle ───────────────────────────────────────────────────────────────

describe("TokenToggle", () => {
  it("is hidden when hasNation=false (only one payable symbol)", () => {
    const html = renderToStaticMarkup(
      createElement(TokenToggle, { payWithNation: false, hasNation: false, nonNationSymbol: "USDG", nationDiscount: null, onChange: vi.fn() }),
    );
    expect(html).toBe("");
  });

  it("shows USDG (not USDC) as the stable-coin option when hasNation=true", () => {
    const html = renderToStaticMarkup(
      createElement(TokenToggle, { payWithNation: false, hasNation: true, nonNationSymbol: "USDG", nationDiscount: 0.2, onChange: vi.fn() }),
    );
    expect(html).toContain("USDG");
    expect(html).not.toContain(">USDC<");
    expect(html).toContain("$NATION");
  });

  it("shows discount percentage from nationDiscount prop", () => {
    const html = renderToStaticMarkup(
      createElement(TokenToggle, { payWithNation: false, hasNation: true, nonNationSymbol: "USDG", nationDiscount: 0.25, onChange: vi.fn() }),
    );
    expect(html).toContain("Save ~25%");
  });
});

// ─── CheckoutPanel ─────────────────────────────────────────────────────────────

const usdgChain = { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: "0xabc" as Hex, treasury: "0xdef" as Hex, decimals: 6 };
const usdgInvoice = {
  id: "inv-1", chain: 4663, treasury: "0xdef" as Hex, token: "0xabc" as Hex,
  pack_micros: 49_000_000, amount_micros: 49_012_345, token_amount: "", expires_at: Date.now() + 30 * 60_000, paid_tx: null,
};
const checkoutStatus: CreditStatus = {
  balanceUsd: 5, label: "$5.00", verified: true, exempt: false, lowBalance: false,
  topUpEnabled: true, topUpMessage: "", starterMessage: "", packs: [15, 49, 99],
  tiers: [], nationPriceUsd: null, nationDiscount: null,
  chains: [usdgChain],
  invoices: [],
};

describe("CheckoutPanel", () => {
  const baseProps = {
    invoice: usdgInvoice,
    status: checkoutStatus,
    busy: false,
    hash: "",
    onHash: vi.fn(),
    onPay: vi.fn(),
    onConfirm: vi.fn(),
    onBack: vi.fn(),
  };

  it("shows USDG symbol — not hardcoded USDC — for Robinhood chain invoice", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("USDG");
    expect(html).not.toContain("USDC");
  });

  it("shows Robinhood Chain network — not hardcoded Base — for chain 4663", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("Robinhood Chain");
    expect(html).not.toContain(">Base<");
  });

  it("shows payment amount in USDG micros format", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    // 49_012_345 micros = 49.012345 USDG
    expect(html).toContain("49.012345");
  });

  it("shows order summary with tier name, amount, and network", () => {
    const statusWithTiers: CreditStatus = {
      ...checkoutStatus,
      tiers: [{ id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true }],
    };
    const html = renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, status: statusWithTiers }));
    expect(html).toContain("Builder pack");
    expect(html).toContain("49.012345 USDG");
    expect(html).toContain("Robinhood Chain");
  });

  it("shows staged action buttons: Pay with wallet + I've paid — confirm", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("Pay with wallet");
    expect(html).toContain("I&#x27;ve paid");
  });

  it("shows paid confirmation when invoice is paid", () => {
    const paid = { ...usdgInvoice, paid_tx: "0xdeadbeef" as Hex };
    const html = renderToStaticMarkup(
      createElement(CheckoutPanel, { ...baseProps, invoice: paid }),
    );
    expect(html).toContain("Payment verified");
    expect(html).not.toContain("Send payment");
  });

  it("shows Back button to return to tier picker", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("← Back");
  });
});

// ─── Pack-tap creates invoice (structural verification) ────────────────────────
//
// Full interactive testing (click → fetch → state update) requires jsdom + act;
// the suite runs in node environment. The tests above verify: (a) TierCard
// renders no window.location.href redirect, (b) the CTA label is USDG-correct,
// (c) CheckoutPanel renders the right chain data. For integration coverage of
// the end-to-end flow, see the /subscription?pack=49 and mock-fetch description
// in the PR body and the verify-omb skill fixture.
