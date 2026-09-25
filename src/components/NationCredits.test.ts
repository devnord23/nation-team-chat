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

import { NationCreditsStrip, TierCard } from "./NationCredits";

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

describe("TierCard", () => {
  const tier = { id: "starter", name: "Starter", usd: 15, creditUsd: 15, popular: false };

  it("renders tier name, price and Choose plan CTA", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { tier, onSelect: vi.fn(), disabled: false }),
    );
    expect(html).toContain("Starter");
    expect(html).toContain("$15");
    expect(html).toContain("Choose plan");
    expect(html).not.toContain("Pay");
    expect(html).not.toContain("USDC");
  });

  it("marks the Most popular badge on popular tiers", () => {
    const popular = { ...tier, popular: true, id: "builder", name: "Builder", usd: 49, creditUsd: 49 };
    const html = renderToStaticMarkup(
      createElement(TierCard, { tier: popular, onSelect: vi.fn(), disabled: false }),
    );
    expect(html).toContain("Most popular");
  });

  it("is disabled when disabled=true", () => {
    const html = renderToStaticMarkup(
      createElement(TierCard, { tier, onSelect: vi.fn(), disabled: true }),
    );
    expect(html).toContain("disabled");
  });
});
