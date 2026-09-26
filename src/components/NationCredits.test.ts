import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";

vi.hoisted(() => {
  vi.stubGlobal("window", { location: { pathname: "/", search: "", assign: vi.fn() } });
  // Match the production build: the app is served under /swarm/ while thenation.city/subscription
  // is the public Full Plans URL. With vitest's own base ("/") the two paths would coincide.
  vi.stubEnv("BASE_URL", "/swarm/");
  vi.stubEnv("DEV", false);
  vi.stubEnv("PROD", true);
});
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { connected: false }, dispatch: vi.fn() }),
  api: vi.fn(),
}));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));

import {
  NationCredits, NationCreditsProvider, NationCreditsStrip, NationCreditsSettingsRow, FullPlansHero, TierCard, TokenToggle,
  CheckoutPanel, PendingInvoices, filterLivePendingInvoices, pendingInvoiceRows, invoiceRequest,
  nationPayable, formatTokenUnits, fullPlansHref, isFullPlansPath, goToFullPlans, FULL_PLANS_HREF,
} from "./NationCredits";
import { NationCreditsCtx, useNationCredits, type CreditStatus, type CreditTier } from "@/lib/nation-credits-ctx";

type Status = Parameters<typeof NationCreditsStrip>[0]["status"];

const chain = { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: "0x1" as Hex, treasury: "0x2" as Hex };
const base: Status = {
  balanceUsd: 5, label: "$5.00 credit", verified: true, exempt: false,
  lowBalance: false, topUpEnabled: true, topUpMessage: "", starterMessage: "",
  packs: [10, 25], chains: [chain], invoices: [],
};

beforeEach(() => vi.unstubAllGlobals());

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Matches an element whose whole text is `text`, e.g. <a …>Top up</a>. */
const element = (tag: string, text: string) => new RegExp(`<${tag}\\b[^>]*>${escapeRegExp(text)}</${tag}>`);
const linkTo = (href: string, text: string) =>
  new RegExp(`<a\\b[^>]*href="${escapeRegExp(href)}"[^>]*>${escapeRegExp(text)}</a>`);

// ─── Full Plans routing ───────────────────────────────────────────────────────

describe("Full Plans location", () => {
  it("is thenation.city/subscription in production builds and base-relative on the dev server", () => {
    expect(fullPlansHref(false, "/swarm/")).toBe("/subscription");
    expect(fullPlansHref(true, "/swarm/")).toBe("/swarm/subscription");
    expect(fullPlansHref(true, "/")).toBe("/subscription");
  });

  it("recognizes both the public path and the base-relative path", () => {
    for (const path of ["/subscription", "/subscription/", "/swarm/subscription", "/swarm/subscription/"]) {
      expect(isFullPlansPath(path, "/swarm/"), path).toBe(true);
    }
    for (const path of ["/", "/swarm/", "/swarm", "/subscriptions", "/swarm/subscription/x", "/admin/subscription"]) {
      expect(isFullPlansPath(path, "/swarm/"), path).toBe(false);
    }
  });

  it("navigates with a full page load to /subscription", () => {
    expect(FULL_PLANS_HREF).toBe("/subscription");
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { pathname: "/swarm/", search: "", assign } });
    goToFullPlans();
    expect(assign).toHaveBeenCalledWith("/subscription");
  });
});

// ─── NationCreditsStrip ────────────────────────────────────────────────────────

describe("NationCreditsStrip", () => {
  it("primary Top up links to Full Plans instead of opening the sheet", () => {
    const onStarter = vi.fn();
    const html = renderToStaticMarkup(createElement(NationCreditsStrip, { status: base, onStarter }));
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
    expect(html).not.toMatch(element("button", "Top up"));
    expect(onStarter).not.toHaveBeenCalled();
  });

  it("keeps the sheet only for Get free starter credit", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, verified: false }, onStarter: vi.fn() }),
    );
    expect(html).toMatch(element("button", "Get free starter credit"));
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
  });

  it("shows Top up when topUpEnabled and NOT exempt", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: true, exempt: false }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Top up");
    expect(html).not.toContain("NATION API");
  });

  it("shows Top up when topUpEnabled AND exempt (owner can test payment flow)", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: true, exempt: true }, onStarter: vi.fn() }),
    );
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
    expect(html).toContain("NATION API");
  });

  it("shows topUpMessage for non-exempt when topUpEnabled is false", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: false, topUpMessage: "Top up launching soon" }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Top up launching soon");
    expect(html).not.toContain(">Top up<");
  });

  it("shows muted topUpMessage for exempt when topUpEnabled is false", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: true, topUpMessage: "Coming soon for members" }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Coming soon for members");
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("NATION API");
  });

  it("renders nothing actionable for exempt + topUpDisabled + no topUpMessage", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, topUpEnabled: false, exempt: true, topUpMessage: "" }, onStarter: vi.fn() }),
    );
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("NATION API");
  });

  it("shows Get free starter credit for unverified users (regardless of exempt)", () => {
    const html = renderToStaticMarkup(
      createElement(NationCreditsStrip, { status: { ...base, verified: false, exempt: true }, onStarter: vi.fn() }),
    );
    expect(html).toContain("Get free starter credit");
  });
});

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const usdgToken = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Hex;
const nationToken = "0xc839a88a05b231515a82c71ee97b4f18973c1340" as Hex;
const robinhoodTreasury = "0x1111111111111111111111111111111111111111" as Hex;
const baseToken = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Hex;

// The live server lists $NATION first whenever NATION_TOKEN_USD_PRICE is set.
const liveChains: CreditStatus["chains"] = [
  { id: 4663, name: "Robinhood Chain", symbol: "$NATION", token: nationToken, treasury: robinhoodTreasury, decimals: 18 },
  { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: usdgToken, treasury: robinhoodTreasury, decimals: 6 },
];
const liveUsdgOnly: CreditStatus["chains"] = [
  { id: 4663, name: "Robinhood Chain", symbol: "USDG", token: usdgToken, treasury: robinhoodTreasury, decimals: 6 },
];

const tiers: CreditTier[] = [
  { id: "starter", name: "Starter", usd: 15, creditUsd: 15, popular: false },
  { id: "builder", name: "Builder", usd: 49, creditUsd: 49, popular: true },
  { id: "swarm", name: "Swarm", usd: 99, creditUsd: 99, popular: false },
];
const liveStatus: CreditStatus = {
  balanceUsd: 5, label: "$5.00 credit left", verified: true, exempt: false, lowBalance: false,
  topUpEnabled: true, topUpMessage: "Top up", starterMessage: "Starter credit already received",
  packs: [15, 49, 99], tiers, nationPriceUsd: 0.000286, nationDiscount: 0.2, chains: liveChains, invoices: [],
};

// ─── Settings → Billing & Credits ─────────────────────────────────────────────

describe("NationCreditsSettingsRow", () => {
  const renderRow = (status: CreditStatus) => renderToStaticMarkup(createElement(
    NationCreditsCtx.Provider,
    { value: { status, refresh: vi.fn(), starterOpen: false, openStarter: vi.fn(), closeStarter: vi.fn(), openSubscription: vi.fn() } },
    createElement(NationCreditsSettingsRow),
  ));

  it("Top up links to Full Plans", () => {
    const html = renderRow(liveStatus);
    expect(html).toContain("Billing &amp; Credits");
    expect(html).toMatch(linkTo(FULL_PLANS_HREF, "Top up"));
    expect(html).not.toMatch(element("button", "Top up"));
  });

  it("shows the server message instead when top up is unavailable", () => {
    const html = renderRow({ ...liveStatus, topUpEnabled: false, topUpMessage: "Top up coming soon", chains: [] });
    expect(html).not.toContain(">Top up<");
    expect(html).toContain("Top up coming soon");
  });
});

describe("NationCreditsProvider", () => {
  // The account menu and Settings are siblings of the strip, not its children.
  const Probe = () => createElement("span", null, String(useNationCredits().openSubscription === goToFullPlans));

  it("gives every consumer under it — account menu, Settings — the real Full Plans navigation", () => {
    vi.stubGlobal("window", { location: { pathname: "/swarm/", search: "", assign: vi.fn() } });
    expect(renderToStaticMarkup(createElement(NationCreditsProvider, null, createElement(Probe)))).toBe("<span>true</span>");
  });

  it("outside it, the context default is a no-op (why the provider wraps the whole app)", () => {
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>false</span>");
  });
});

// ─── Full Plans page ──────────────────────────────────────────────────────────

describe("Full Plans page", () => {
  const renderAt = (pathname: string) => {
    vi.stubGlobal("window", { location: { pathname, search: "", assign: vi.fn() }, history: { length: 1 } });
    return renderToStaticMarkup(createElement(NationCredits));
  };

  it("renders the Full Plans banner on thenation.city/subscription, with no sheet", () => {
    const html = renderAt("/subscription");
    expect(html).toContain('id="full-plans-title"');
    expect(html).toMatch(element("h1", "Full Plans"));
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("Top up credits");
  });

  it("renders the banner on the base-relative path too", () => {
    expect(renderAt("/swarm/subscription/")).toMatch(element("h1", "Full Plans"));
  });

  it("stays out of the chat shell elsewhere", () => {
    expect(renderAt("/swarm/")).not.toContain("Full Plans");
  });

  it("hero carries the N mark and the permanent-credit pitch", () => {
    const html = renderToStaticMarkup(createElement(FullPlansHero, { status: liveStatus }));
    expect(html).toMatch(/<img[^>]*src="[^"]*nation-logo\.svg"/);
    expect(html).toContain("Permanent credit");
    expect(html).toContain("Never expires");
    expect(html).toContain("Pay with USDG or $NATION");
  });

  it("hero offers only USDG when $NATION is not payable", () => {
    const html = renderToStaticMarkup(createElement(FullPlansHero, { status: { ...liveStatus, nationPriceUsd: null } }));
    expect(html).toContain("Pay with USDG");
    expect(html).not.toContain("$NATION");
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
    nonNationSymbol: "USDG",
    onSelect: vi.fn(),
    disabled: false,
  };

  it("renders USDG CTA label — not USDC", () => {
    const html = renderToStaticMarkup(createElement(TierCard, baseProps));
    expect(html).toContain("Pay with USDG");
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

  it("prices the pack in $NATION when paying with $NATION", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: true, nationPriceUsd: 0.5 }),
    );
    expect(html).toContain("$49");
    expect(html).toContain("≈ 98 $NATION");
    expect(html).toContain("Pay with $NATION");
    expect(html).not.toContain("USDG");
  });

  it("formats large $NATION amounts at the live price", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: true, nationPriceUsd: 0.000286 }),
    );
    expect(html).toContain("≈ 171,328.67 $NATION");
  });

  it("shows only the chosen currency: USDG when not paying with $NATION, even if it is priced", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: false, nationPriceUsd: 0.5 }),
    );
    expect(html).toContain("49 USDG");
    expect(html).not.toContain("$NATION");
  });

  it("falls back to the stablecoin when $NATION is not priced", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { ...baseProps, payWithNation: true, nationPriceUsd: null }),
    );
    expect(html).toContain("Pay with USDG");
    expect(html).not.toContain("$NATION");
  });
});

// ─── Pay with (TokenToggle) ────────────────────────────────────────────────────

describe("TokenToggle", () => {
  const props = { payWithNation: false, hasNation: true, nonNationSymbol: "USDG", nationDiscount: 0.2, onChange: vi.fn() };
  const checkedValue = (html: string) =>
    [...html.matchAll(/<input\b[^>]*>/g)].map(([tag]) => tag).filter((tag) => /\bchecked=""/.test(tag))
      .map((tag) => /value="([^"]*)"/.exec(tag)?.[1]);

  it("is hidden when hasNation=false (only one payable symbol — live Robinhood USDG config)", () => {
    const html = renderToStaticMarkup(
      createElement(TokenToggle, { ...props, hasNation: false, nationDiscount: null }),
    );
    expect(html).toBe("");
  });

  it("is a large, labelled radio choice with USDG selected by default", () => {
    const html = renderToStaticMarkup(createElement(TokenToggle, props));
    expect(html).toMatch(element("legend", "Pay with"));
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(checkedValue(html)).toEqual(["USDG"]);
    expect(html).toContain("Paying with <strong>USDG</strong>");
    expect(html).not.toContain(">USDC<");
  });

  it("marks $NATION as the one selected option when chosen", () => {
    const html = renderToStaticMarkup(createElement(TokenToggle, { ...props, payWithNation: true }));
    expect(checkedValue(html)).toEqual(["NATION"]);
    expect(html).toContain("Paying with <strong>$NATION</strong>");
    // The selected option is a filled accent surface; the other stays a plain panel.
    const labels = [...html.matchAll(/<label\b[^>]*class="([^"]*)"/g)].map(([, cls]) => cls);
    expect(labels.filter((cls) => /\bbg-accent\b/.test(cls))).toHaveLength(1);
    expect(labels[1]).toMatch(/\bbg-accent\b/);
  });

  it("shows discount percentage from nationDiscount prop", () => {
    const html = renderToStaticMarkup(createElement(TokenToggle, { ...props, nationDiscount: 0.25 }));
    expect(html).toContain("Save ~25%");
  });

  it("does not invent a discount the server did not send", () => {
    const html = renderToStaticMarkup(createElement(TokenToggle, { ...props, nationDiscount: null }));
    expect(html).not.toContain("Save ~");
  });
});

describe("nationPayable (toggle gating)", () => {
  it("needs both the $NATION chain entry and a positive price", () => {
    expect(nationPayable(liveStatus)).toBe(true);
    expect(nationPayable({ chains: liveChains, nationPriceUsd: null })).toBe(false);
    expect(nationPayable({ chains: liveChains, nationPriceUsd: 0 })).toBe(false);
    expect(nationPayable({ chains: liveUsdgOnly, nationPriceUsd: 0.000286 })).toBe(false);
    expect(nationPayable(null)).toBe(false);
  });
});

// ─── Invoice creation ─────────────────────────────────────────────────────────

describe("invoiceRequest", () => {
  it("sends chain + token + packUsd so USDG and $NATION on chain 4663 stay distinct", () => {
    expect(invoiceRequest(liveChains, false, 49)).toEqual({ chain: 4663, token: usdgToken, packUsd: 49 });
    expect(invoiceRequest(liveChains, true, 49)).toEqual({ chain: 4663, token: nationToken, packUsd: 49 });
  });

  it("refuses $NATION when the server does not offer it", () => {
    expect(invoiceRequest(liveUsdgOnly, true, 15)).toBeNull();
    expect(invoiceRequest([], false, 15)).toBeNull();
  });
});

describe("formatTokenUnits", () => {
  it("is exact at 18 decimals, where a rounded figure would never match the transfer", () => {
    expect(formatTokenUnits(52_447_552_447_552_447_552_447n, 18)).toBe("52447.552447552447552447");
    expect(formatTokenUnits(49_012_345n, 6)).toBe("49.012345");
    expect(formatTokenUnits(15_000_000n, 6)).toBe("15");
    expect(formatTokenUnits(5n, 18)).toBe("0.000000000000000005");
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

  it("shows order summary (tier, credit, network) and the exact amount to send", () => {
    const html = renderToStaticMarkup(createElement(CheckoutPanel, baseProps));
    expect(html).toContain("Builder pack");
    expect(html).toContain("$49 permanent credit");
    expect(html).toContain("49.012345 USDG");
    expect(html).toContain("Robinhood Chain");
  });

  it("asks for the exact $NATION amount the payment check expects", () => {
    const nationInvoice = {
      ...usdgInvoice, token: nationToken, treasury: robinhoodTreasury,
      token_amount: "171372552447552447552447",
    };
    const html = renderToStaticMarkup(
      createElement(CheckoutPanel, { ...baseProps, invoice: nationInvoice, status: liveStatus }),
    );
    expect(html).toContain("171372.552447552447552447 $NATION");
    expect(html).not.toContain("USDG");
  });

  it("names the USDG invoice correctly even though $NATION is listed first on the same chain id", () => {
    const invoice = { ...usdgInvoice, token: usdgToken, treasury: robinhoodTreasury, token_amount: "49012345" };
    const html = renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, invoice, status: liveStatus }));
    expect(html).toContain("49.012345 USDG");
    expect(html).not.toContain("$NATION");
  });

  it("never guesses a symbol for an invoice whose token is no longer offered", () => {
    const orphan = { ...usdgInvoice, chain: 8453, token: baseToken };
    const html = renderToStaticMarkup(createElement(CheckoutPanel, { ...baseProps, invoice: orphan }));
    expect(html).toContain("no longer offered");
    expect(html).not.toContain(" ?");
    expect(html).not.toContain("Pay with wallet");
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
    // Named apart from the page's own "← Back", which leaves Full Plans.
    expect(html).toMatch(element("button", "← Back to packs"));
  });
});

// ─── filterLivePendingInvoices ────────────────────────────────────────────────

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

  it("matches token addresses case-insensitively", () => {
    const checksummed = makeInvoice(4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Hex);
    expect(filterLivePendingInvoices([checksummed], liveUsdgOnly)).toHaveLength(1);
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

// ─── Pending rows (what Full Plans shows) ─────────────────────────────────────

describe("pendingInvoiceRows", () => {
  // The rows the founder saw on the live page, rebuilt from the old defaults and chain order:
  //   – a $25 pack on Base from before the Robinhood-only migration ("25.1462 ?")
  //   – a USDG invoice read against the $NATION entry listed first ("0.0000 $NATION")
  const baseOrphan = { ...makeInvoice(8453, baseToken), pack_micros: 25_000_000, amount_micros: 25_146_200 };
  const usdgPending = { ...makeInvoice(4663, usdgToken), amount_micros: 15_123_456, token_amount: "15123456" };
  const nationPending = { ...makeInvoice(4663, nationToken), amount_micros: 15_123_456, token_amount: "52879216783216783216783" };
  // A $NATION-token row carrying a stablecoin-sized amount is not a real payment request.
  const zeroNation = { ...makeInvoice(4663, nationToken), amount_micros: 15_123_456, token_amount: "15123456" };

  it("never renders '?' and hides the orphan Base invoice", () => {
    const rows = pendingInvoiceRows([baseOrphan, usdgPending], liveChains);
    expect(rows.map((r) => r.invoice.id)).toEqual([usdgPending.id]);
    expect(rows.every((r) => r.symbol === "USDG" || r.symbol === "$NATION")).toBe(true);
  });

  it("labels a USDG invoice as USDG with its real amount even though $NATION is listed first", () => {
    const [row] = pendingInvoiceRows([usdgPending], liveChains);
    expect(row).toMatchObject({ symbol: "USDG", amount: "15.1235" });
  });

  it("hides zero-amount pending invoices (0.0000 …)", () => {
    expect(pendingInvoiceRows([zeroNation], liveChains)).toEqual([]);
    const empty = { ...makeInvoice(4663, usdgToken), amount_micros: 0, token_amount: "0" };
    expect(pendingInvoiceRows([empty], liveChains)).toEqual([]);
  });

  it("shows $NATION amounts in whole tokens", () => {
    const [row] = pendingInvoiceRows([nationPending], liveChains);
    expect(row).toMatchObject({ symbol: "$NATION", amount: "52,879.2168" });
  });

  it("hides rows whose stored amount cannot be read", () => {
    expect(pendingInvoiceRows([{ ...usdgPending, token_amount: "not-a-number" }], liveChains)).toEqual([]);
  });

  it("flags expired requests instead of showing a past expiry time", () => {
    const now = Date.now();
    const [row] = pendingInvoiceRows([{ ...usdgPending, expires_at: now - 1 }], liveChains, now);
    expect(row.expired).toBe(true);
  });

  it("renders a list with no '?' and no zero rows", () => {
    const rows = pendingInvoiceRows([baseOrphan, usdgPending, nationPending, zeroNation], liveChains);
    const html = renderToStaticMarkup(createElement(PendingInvoices, { rows, onResume: vi.fn(), disabled: false }));
    expect(html).toContain("15.1235 USDG");
    expect(html).toContain("52,879.2168 $NATION");
    expect(html).not.toContain("?");
    expect(html).not.toContain("0.0000");
    expect(html).not.toContain("25.1462");
  });

  it("renders nothing when there is nothing to resume", () => {
    expect(renderToStaticMarkup(createElement(PendingInvoices, { rows: [], onResume: vi.fn(), disabled: false }))).toBe("");
  });
});
