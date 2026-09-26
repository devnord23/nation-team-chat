import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

vi.hoisted(() => { vi.stubGlobal("window", { location: { pathname: "/", search: "", assign: vi.fn() } }); });
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { connected: false }, dispatch: vi.fn() }),
  api: vi.fn(),
}));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));

import { NationCreditsStrip, TierCard, TokenToggle, CheckoutPanel, filterLivePendingInvoices } from "./NationCredits";
import type { CreditStatus, CreditTier } from "@/lib/nation-credits-ctx";

type Status = Parameters<typeof NationCreditsStrip>[0]["status"];

const chain = { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: "0x1" as Hex, treasury: "0x2" as Hex };
const base: Status = {
  balanceUsd: 5, label: "$5.00 credit", verified: true, exempt: false,
  lowBalance: false, topUpEnabled: true, topUpMessage: "", starterMessage: "",
  packs: [10, 25], chains: [chain], invoices: [],
};

beforeEach(() => vi.unstubAllGlobals());

// ─── NationCreditsStrip ────────────────────────────────────────────────────────

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

  it("does not contain window.location.href redirect", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).not.toContain("window.location.href");
    expect(html).not.toContain("thenation.city/subscription");
  });

  it("renders pack price and name prominently", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).toContain("$49");
    expect(html).toContain("Builder");
    expect(html).toContain("49 permanent credit");
  });

  it("shows Most popular badge on popular tier", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).toContain("Most popular");
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

  it("shows dual prices: USDG primary + NATION secondary when nationPriceUsd is set and payWithNation=false", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: false, nationPriceUsd: 0.5, nationDiscount: 0.2 }),
    );
    expect(html).toContain("$49");
    expect(html).toContain("$NATION");
    expect(html).toContain("save ~20%");
  });

  it("shows dual prices: NATION primary + USD secondary when payWithNation=true", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: true, nationPriceUsd: 0.5, nationDiscount: 0.2 }),
    );
    expect(html).toContain("$NATION");
    expect(html).toContain("= $49 value");
  });

  it("no secondary price when nationPriceUsd is null (USDG-only)", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).not.toContain("save ~");
    expect(html).not.toContain("= $");
  });
});

// ─── TokenToggle ───────────────────────────────────────────────────────────────

describe("TokenToggle", () => {
  it("is hidden when hasNation=false (only one payable symbol — live Robinhood USDG config)", () => {
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
  pack_micros: 49_000_000, amount_micros: 49_012_345, token_amount: "",
  expires_at: Date.now() + 30 * 60_000, paid_tx: null,
};
const checkoutStatus: CreditStatus = {
  balanceUsd: 5, label: "$5.00", verified: true, exempt: false, lowBalance: false,
  topUpEnabled: true, topUpMessage: "", starterMessage: "", packs: [15, 49, 99],
  tiers: [{ id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true }],
  nationPriceUsd: null, nationDiscount: null,
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

  it("shows payment amount from invoice.amount_micros", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    // 49_012_345 micros → 49.012345 USDG
    expect(html).toContain("49.012345");
  });

  it("shows order summary with tier name, amount, and network", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
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

// ─── /subscription full-page smoke (structural) ───────────────────────────────
//
// Full interactive tests (navigation, click events, state changes) require a
// jsdom environment; the suite runs in node. The tests above verify:
//   (a) TierCard renders no redirect, shows USDG, shows dual prices
//   (b) TokenToggle hidden when NATION unpriced (live Robinhood USDG config)
//   (c) CheckoutPanel shows Robinhood Chain / USDG / order summary / staged buttons
//
// End-to-end: visit /subscription, pick Builder, see checkout modal with USDG.

// ─── filterLivePendingInvoices ────────────────────────────────────────────────

const usdgToken = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Hex;
const nationToken = "0xc839a88a05b231515a82c71ee97b4f18973c1340" as Hex;
const robinhoodTreasury = "0x1111111111111111111111111111111111111111" as Hex;
const baseToken = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Hex;

const liveChains: CreditStatus["chains"] = [
  { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: usdgToken, treasury: robinhoodTreasury, decimals: 6 },
  { id: 4663, name: "Robinhood Chain", symbol: "$NATION", token: nationToken, treasury: robinhoodTreasury, decimals: 18 },
];
const liveUsdgOnly: CreditStatus["chains"] = [
  { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: usdgToken, treasury: robinhoodTreasury, decimals: 6 },
];

const makeInvoice = (chain: number, token: Hex, paid = false): CreditStatus["invoices"][number] => ({
  id: crypto.randomUUID(),
  chain, treasury: robinhoodTreasury, token,
  pack_micros: 15_000_000, amount_micros: 15_000_500, token_amount: "",
  expires_at: Date.now() + 3_600_000,
  paid_tx: paid ? ("0x" + "a".repeat(64)) as Hex : null,
});

describe("filterLivePendingInvoices", () => {
  it("keeps invoices whose chain+token pair is in live chains", () => {
    const inv = makeInvoice(4663, usdgToken);
    expect(filterLivePendingInvoices([inv], liveUsdgOnly)).toHaveLength(1);
  });

  it("removes invoices on a dropped chain (Base 8453 after Robinhood-only migration)", () => {
    const orphan = makeInvoice(8453, baseToken);
    const result = filterLivePendingInvoices([orphan], liveUsdgOnly);
    expect(result).toHaveLength(0);
  });

  it("removes paid invoices even when their chain is live", () => {
    const paid = makeInvoice(4663, usdgToken, true);
    expect(filterLivePendingInvoices([paid], liveUsdgOnly)).toHaveLength(0);
  });

  it("distinguishes USDG and $NATION on the same chain id 4663 by token address", () => {
    const usdgInv = makeInvoice(4663, usdgToken);
    const nationInv = makeInvoice(4663, nationToken);
    // Both chains live → both invoices kept
    expect(filterLivePendingInvoices([usdgInv, nationInv], liveChains)).toHaveLength(2);
    // Only USDG live → only USDG invoice kept
    expect(filterLivePendingInvoices([usdgInv, nationInv], liveUsdgOnly)).toHaveLength(1);
    expect(filterLivePendingInvoices([usdgInv, nationInv], liveUsdgOnly)[0].token).toBe(usdgToken);
  });

  it("returns empty list when chains is empty", () => {
    const inv = makeInvoice(4663, usdgToken);
    expect(filterLivePendingInvoices([inv], [])).toHaveLength(0);
  });

  it("returns empty list when invoices is empty", () => {
    expect(filterLivePendingInvoices([], liveChains)).toHaveLength(0);
  });

  it("mixed: keeps live pending, drops orphan, drops paid", () => {
    const livePending = makeInvoice(4663, usdgToken);
    const orphan = makeInvoice(8453, baseToken);
    const paid = makeInvoice(4663, usdgToken, true);
    const result = filterLivePendingInvoices([livePending, orphan, paid], liveUsdgOnly);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(livePending);
  });
});
