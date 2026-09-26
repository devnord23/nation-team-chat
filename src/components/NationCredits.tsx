/**
 * Nation credit top-up UX.
 *
 * Full Plans is the one place credit is bought:
 *   – thenation.city/subscription (vercel.json rewrite) and <base>/subscription render it
 *   – ?pack=15|49|99 starts checkout for that pack; ?asset=USDG|NATION pre-selects the pay token
 *   – the top strip's "Top up", Settings → Billing & Credits and the account menu's
 *     "Add credits" all navigate there with a full page load
 * The bottom sheet is kept only for "Get free starter credit" (wallet verification).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check } from "lucide-react";
import type { EIP1193Provider, Hex } from "viem";
import { api, useStore } from "@/state/store";
import { NationCreditsCtx, useNationCredits, type CreditStatus, type CreditTier } from "@/lib/nation-credits-ctx";
import { SettingRow } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

const BASE_URL = import.meta.env.BASE_URL;

/** Where Full Plans lives. Production hosts answer thenation.city/subscription (a vercel.json
 * rewrite; the desktop server serves the app for every path), while the Vite dev server only
 * serves paths under the base. */
export function fullPlansHref(dev: boolean, base: string): string {
  return dev ? `${base}subscription`.replace(/\/\//g, "/") : "/subscription";
}
export const FULL_PLANS_HREF = fullPlansHref(import.meta.env.DEV, BASE_URL);

/** The public URL and the base-relative one both render Full Plans. */
export function isFullPlansPath(pathname: string, base: string): boolean {
  const path = pathname.replace(/\/+$/, "");
  return path === "/subscription" || path === `${base}subscription`.replace(/\/\//g, "/");
}

/** Buying credit is a page of its own, never the sheet. */
export function goToFullPlans(): void {
  window.location.assign(FULL_PLANS_HREF);
}

// ─── style tokens ────────────────────────────────────────────────────────────
const btn =
  "rounded-xl bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-50 transition-opacity";
const field =
  "w-full rounded-xl border border-hairline/50 bg-inset p-3 text-ink focus:outline-none focus:border-accent/60";

// Narrow status type used by the pure strip + the Settings row.
type StripStatus = {
  balanceUsd: number;
  label: string;
  verified: boolean;
  exempt: boolean;
  lowBalance: boolean;
  topUpEnabled: boolean;
  topUpMessage: string;
  starterMessage: string;
  packs: number[];
  chains: Array<{ id: number; name: string; symbol: string; token: string; treasury: string }>;
  invoices: Array<{ id: string; chain: number; treasury: string; token: string; pack_micros: number; amount_micros: number; expires_at: number; paid_tx: string | null }>;
};

type Chain = CreditStatus["chains"][number];
type Invoice = CreditStatus["invoices"][number];

// ─── Payment helpers (exported for unit tests) ───────────────────────────────
/** An invoice's own chain entry. USDG and $NATION share Robinhood Chain's id, so the token
 * address has to match too. */
function chainFor(invoice: Pick<Invoice, "chain" | "token">, chains: Chain[]): Chain | undefined {
  return chains.find((c) => c.id === invoice.chain && c.token.toLowerCase() === invoice.token.toLowerCase());
}

/** $NATION is offered only when the server lists its chain entry and prices it. */
export function nationPayable(status: Pick<CreditStatus, "chains" | "nationPriceUsd"> | null): boolean {
  return Boolean(
    status && status.nationPriceUsd != null && status.nationPriceUsd > 0 &&
      status.chains.some((c) => c.symbol === "$NATION"),
  );
}

/** Body for POST /api/credits/invoices. The token address, not the shared chain id, picks
 * the currency the invoice is billed in. */
export function invoiceRequest(
  chains: Chain[],
  payWithNation: boolean,
  packUsd: number,
): { chain: number; token: string; packUsd: number } | null {
  const chain = chains.find((c) => (c.symbol === "$NATION") === payWithNation);
  return chain ? { chain: chain.id, token: chain.token, packUsd } : null;
}

/** An exact on-chain amount in whole tokens: 52447552447552447552447n at 18 decimals is
 * "52447.552447552447552447". A rounded figure would ask for a transfer that never matches. */
export function formatTokenUnits(units: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${units / scale}.${fraction}` : String(units / scale);
}

/** What an invoice asks for, in whole tokens of its chain entry. Stablecoin invoices from
 * before token_amount existed carry only micros, which are already their token units. */
export function invoiceAmount(invoice: Invoice, chain: Chain): string {
  return formatTokenUnits(BigInt(invoice.token_amount || invoice.amount_micros), chain.decimals ?? 6);
}

// ─── Orphan invoice guard (exported for unit tests) ───────────────────────────
/**
 * Return only pending invoices whose chain+token pair is still present in the
 * live `chains` list. Invoices on dropped chains (e.g. old Base invoices after
 * the Robinhood-only migration) are excluded so the symbol never falls back to
 * "?".
 */
export function filterLivePendingInvoices(
  invoices: Invoice[],
  chains: Chain[],
): Invoice[] {
  return invoices.filter((i) => !i.paid_tx && chainFor(i, chains) !== undefined);
}

export type PendingRow = { invoice: Invoice; symbol: string; amount: string; expired: boolean };

/** Pending payment requests worth offering to resume: unpaid, on a chain+token pair the
 * server still offers, and for an amount that is not zero at the precision shown. Anything
 * else is what used to render as "25.1462 ?" or "0.0000 $NATION". */
export function pendingInvoiceRows(invoices: Invoice[], chains: Chain[], now = Date.now()): PendingRow[] {
  return filterLivePendingInvoices(invoices, chains).flatMap((invoice) => {
    const chain = chainFor(invoice, chains)!;
    let amount: number;
    try {
      amount = Number(invoiceAmount(invoice, chain));
    } catch {
      return [];
    }
    if (!(amount >= 0.00005)) return [];
    return [{
      invoice,
      symbol: chain.symbol,
      amount: amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
      expired: invoice.expires_at <= now,
    }];
  });
}

// ─── wallet helpers ───────────────────────────────────────────────────────────
async function injectedWallet() {
  const { createWalletClient, custom } = await import("viem");
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider)
    throw new Error(
      "Open an injected wallet, or use the address and transaction hash below.",
    );
  return createWalletClient({ transport: custom(provider) });
}

// ─── Pure strip (exported for tests and reuse) ────────────────────────────────
/** Top banner shown in the chat shell. "Top up" is a link to Full Plans; only the free
 * starter credit opens the sheet. Hidden on Full Plans itself. */
export function NationCreditsStrip({ status, onStarter }: { status: StripStatus; onStarter: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-b border-hairline/30 bg-panel px-4 py-2 text-xs text-ink">
      <span>{status.exempt ? "NATION API" : status.label}</span>
      {status.lowBalance && status.verified && (
        <span>Your teammates are ready when you are. Add credit to keep going.</span>
      )}
      {!status.verified && (
        <button className="underline" onClick={onStarter}>
          Get free starter credit
        </button>
      )}
      {status.topUpEnabled ? (
        <a className="font-medium underline" href={FULL_PLANS_HREF}>
          Top up
        </a>
      ) : !status.exempt ? (
        <span>{status.topUpMessage}</span>
      ) : status.topUpMessage ? (
        <span className="text-ink-secondary">{status.topUpMessage}</span>
      ) : null}
    </div>
  );
}

// ─── Full Plans banner ────────────────────────────────────────────────────────
/** The hero at the top of Full Plans. Exported for unit tests. */
export function FullPlansHero({ status }: { status: CreditStatus | null }) {
  const stableSymbol = status?.chains.find((c) => c.symbol !== "$NATION")?.symbol ?? "USDG";
  const points = [
    "Never expires",
    "No subscription",
    nationPayable(status) ? `Pay with ${stableSymbol} or $NATION` : `Pay with ${stableSymbol}`,
  ];
  return (
    <section
      aria-labelledby="full-plans-title"
      className="relative overflow-hidden rounded-[32px] border border-hairline bg-panel px-6 py-12 sm:px-14 sm:py-16"
    >
      <div aria-hidden className="pointer-events-none absolute -right-24 -top-28 size-[440px] rounded-full bg-accent/25 blur-3xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-36 -left-20 size-[340px] rounded-full bg-accent/10 blur-3xl" />
      <div className="relative flex flex-col items-center gap-8 text-center sm:flex-row sm:text-left">
        <img
          src={`${BASE_URL}nation-logo.svg`}
          alt=""
          width={112}
          height={112}
          className="size-24 shrink-0 rounded-[28px] shadow-2xl ring-1 ring-hairline sm:size-28"
        />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold uppercase tracking-[0.22em] text-accent-text">NATION</p>
          <h1
            id="full-plans-title"
            className="mt-2 text-[44px] font-extrabold leading-[1.02] tracking-tight text-ink sm:text-[64px]"
          >
            Full Plans
          </h1>
          <p className="mt-4 max-w-xl text-[17px] leading-relaxed text-ink-secondary sm:text-[19px]">
            Permanent credit for your whole AI team. Top up once — it never expires, and it is
            only spent when your teammates work.
          </p>
        </div>
      </div>
      <ul className="relative mt-8 flex flex-wrap justify-center gap-2 sm:justify-start">
        {points.map((point) => (
          <li
            key={point}
            className="flex items-center gap-1.5 rounded-full border border-hairline bg-inset px-3 py-1.5 text-[13px] font-medium text-ink"
          >
            <Check aria-hidden className="size-3.5 text-accent-text" strokeWidth={3} />
            {point}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ─── Tier card ───────────────────────────────────────────────────────────────
/** Exported for unit tests. Tapping the card starts checkout for that pack in the
 * currency chosen under "Pay with". */
export function TierCard({
  tier,
  selected,
  payWithNation,
  nationPriceUsd,
  nonNationSymbol,
  onSelect,
  disabled,
}: {
  tier: CreditTier;
  selected: boolean;
  payWithNation: boolean;
  nationPriceUsd: number | null;
  nonNationSymbol: string;
  onSelect: () => void;
  disabled: boolean;
}) {
  const nationAmount =
    payWithNation && nationPriceUsd && nationPriceUsd > 0
      ? (tier.usd / nationPriceUsd).toLocaleString("en-US", { maximumFractionDigits: 2 })
      : null;
  const payLine = nationAmount ? `≈ ${nationAmount} $NATION` : `${tier.usd} ${nonNationSymbol}`;
  const ctaLabel = nationAmount ? "Pay with $NATION" : `Pay with ${nonNationSymbol}`;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "relative flex flex-col gap-3 rounded-3xl border-2 p-6 text-left transition-all",
        selected
          ? "border-accent bg-panel shadow-lg"
          : "border-hairline bg-panel hover:border-accent/60",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {tier.popular && (
        <span className="absolute -top-3 left-6 rounded-full bg-accent px-3 py-1 text-[11px] font-semibold uppercase tracking-wide">
          Most popular
        </span>
      )}
      <p className="text-[15px] font-semibold text-ink-secondary">{tier.name}</p>
      <p className="text-[44px] font-extrabold leading-none tracking-tight text-ink">${tier.usd}</p>
      <p className="text-[14px] font-semibold text-accent-text">{payLine}</p>
      <p className="text-[13px] text-ink-secondary">
        ${tier.creditUsd} permanent credit · never expires
      </p>
      <span className="mt-auto block w-full rounded-xl bg-accent py-3 text-center text-[14px] font-semibold">
        {ctaLabel}
      </span>
    </button>
  );
}

// ─── Payment token choice ─────────────────────────────────────────────────────
/** "Pay with" — shown only when $NATION is actually payable (see nationPayable). */
export function TokenToggle({
  payWithNation,
  hasNation,
  nonNationSymbol,
  nationDiscount,
  onChange,
  disabled = false,
}: {
  payWithNation: boolean;
  hasNation: boolean;
  nonNationSymbol: string;
  nationDiscount: number | null;
  onChange: (nation: boolean) => void;
  disabled?: boolean;
}) {
  if (!hasNation) return null;
  const discountPct = nationDiscount ? Math.round(nationDiscount * 100) : null;
  const options = [
    { nation: false, symbol: nonNationSymbol, detail: "Stablecoin · 1 = $1" },
    { nation: true, symbol: "$NATION", detail: "NATION token" },
  ];
  return (
    <fieldset disabled={disabled}>
      <legend className="text-[24px] font-bold tracking-tight text-ink">Pay with</legend>
      <p className="mt-1 text-[14px] text-ink-secondary">
        Pick the token you'll send on Robinhood Chain. Prices below follow your choice.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3">
        {options.map(({ nation, symbol, detail }) => {
          const checked = payWithNation === nation;
          return (
            <label
              key={symbol}
              className={cn(
                "flex cursor-pointer flex-col gap-1.5 rounded-2xl border-2 px-4 py-4 transition-colors sm:px-5",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-app",
                checked
                  ? "border-accent bg-accent shadow-lg"
                  : "border-hairline bg-panel text-ink-secondary hover:border-accent/60 hover:text-ink",
              )}
            >
              <input
                type="radio"
                name="nation-pay-asset"
                value={nation ? "NATION" : nonNationSymbol}
                checked={checked}
                onChange={() => onChange(nation)}
                className="sr-only"
              />
              <span className="flex items-center justify-between gap-2">
                <span className="text-[22px] font-bold leading-tight sm:text-[26px]">{symbol}</span>
                {checked ? (
                  <Check aria-hidden className="size-6 shrink-0" strokeWidth={3} />
                ) : (
                  <span aria-hidden className="size-5 shrink-0 rounded-full border-2 border-current opacity-60" />
                )}
              </span>
              <span className="text-[13px]">{detail}</span>
              {nation && discountPct != null && (
                <span
                  className={cn(
                    "w-fit rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    checked ? "border border-current" : "bg-accent/15 text-accent-text",
                  )}
                >
                  Save ~{discountPct}%
                </span>
              )}
            </label>
          );
        })}
      </div>
      <p aria-live="polite" className="mt-3 text-[14px] text-ink">
        Paying with <strong>{payWithNation ? "$NATION" : nonNationSymbol}</strong> on Robinhood Chain.
      </p>
    </fieldset>
  );
}

// ─── Checkout stages ──────────────────────────────────────────────────────────
/** Exported for unit tests. */
export function CheckoutSteps({ stage }: { stage: 1 | 2 | 3 }) {
  const steps = ["Choose a pack", "Send payment", "Credit added"];
  return (
    <ol className="flex flex-wrap items-center justify-center gap-2 text-[13px] font-medium sm:gap-3">
      {steps.map((label, index) => {
        const step = index + 1;
        const current = step === stage;
        return (
          <li
            key={label}
            aria-current={current ? "step" : undefined}
            className={cn("flex items-center gap-2", current ? "text-ink" : "text-ink-secondary")}
          >
            <span
              className={cn(
                "flex size-6 items-center justify-center rounded-full border text-[12px] font-bold",
                step <= stage ? "border-accent bg-accent" : "border-hairline",
              )}
            >
              {step < stage ? "✓" : step}
            </span>
            <span className={cn(!current && "hidden sm:inline")}>{label}</span>
            {step < steps.length && <span aria-hidden className="h-px w-6 bg-hairline sm:w-10" />}
          </li>
        );
      })}
    </ol>
  );
}

/** Pending payment requests on Full Plans. Exported for unit tests. */
export function PendingInvoices({
  rows,
  onResume,
  disabled,
}: {
  rows: PendingRow[];
  onResume: (invoice: Invoice) => void;
  disabled: boolean;
}) {
  if (!rows.length) return null;
  return (
    <section className="mt-10 space-y-2">
      <h2 className="text-[13px] font-semibold text-ink-secondary">Resume a pending payment</h2>
      {rows.map(({ invoice, symbol, amount, expired }) => (
        <button
          key={invoice.id}
          type="button"
          disabled={disabled}
          onClick={() => onResume(invoice)}
          className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-hairline/60 bg-inset px-4 py-3 text-left text-[13px] text-ink hover:bg-raised/50"
        >
          <span className="font-semibold">
            {amount} {symbol}
          </span>
          <span className="text-ink-secondary">
            {expired ? "Expired" : `Expires ${new Date(invoice.expires_at).toLocaleTimeString()}`}
          </span>
        </button>
      ))}
    </section>
  );
}

/** Exported for unit tests. */
export function CheckoutPanel({
  invoice,
  status,
  busy,
  hash,
  onHash,
  onPay,
  onConfirm,
  onBack,
}: {
  invoice: Invoice;
  status: CreditStatus;
  busy: boolean;
  hash: string;
  onHash: (v: string) => void;
  onPay: () => void;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const chain = chainFor(invoice, status.chains);
  const packUsd = invoice.pack_micros / 1_000_000;
  const tier = status.tiers.find((t) => t.usd === packUsd);
  const tierName = tier?.name ?? `$${packUsd}`;
  const back = (
    <button
      type="button"
      onClick={onBack}
      disabled={busy}
      className="text-[13px] text-ink-secondary hover:text-ink"
    >
      ← Back to packs
    </button>
  );

  if (invoice.paid_tx) {
    return (
      <div className="space-y-5 rounded-3xl border border-hairline bg-panel p-6 text-center">
        <p role="status" className="text-[17px] font-semibold text-success">
          ✓ Payment verified. Your credit is ready.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <a className={btn} href={BASE_URL}>
            Back to chat
          </a>
          <button
            type="button"
            onClick={onBack}
            className="rounded-xl border border-hairline px-4 py-2 font-medium text-ink hover:bg-raised"
          >
            Buy another pack
          </button>
        </div>
      </div>
    );
  }

  let amount: string | null = null;
  try {
    if (chain) amount = invoiceAmount(invoice, chain);
  } catch {
    amount = null;
  }
  if (!chain || amount === null) {
    return (
      <div className="space-y-3 rounded-3xl border border-hairline bg-panel p-6">
        <p className="text-[14px] text-ink">
          This payment request is for a network or token that is no longer offered. Choose a
          pack to start a new one.
        </p>
        {back}
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-3xl border border-hairline bg-panel p-5 sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <h2 tabIndex={-1} className="text-[20px] font-bold text-ink focus:outline-none">
          Send payment
        </h2>
        {back}
      </div>

      {/* Order summary: what the payment buys; the exact amount follows */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl bg-inset px-3 py-2 text-[13px]">
        <span className="font-semibold text-ink">{tierName} pack</span>
        <span className="text-ink-secondary">·</span>
        <span className="font-semibold text-ink">${tier?.creditUsd ?? packUsd} permanent credit</span>
        <span className="text-ink-secondary">·</span>
        <span className="text-ink-secondary">{chain.name}</span>
      </div>

      <div className="rounded-2xl bg-inset p-4">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">Send exactly</p>
        <p className="mt-1 break-all font-mono text-[20px] font-bold text-ink">
          {amount} {chain.symbol}
        </p>
        <p className="mt-1 text-xs text-ink-secondary">
          The unique amount identifies your payment — the full amount is credited.
        </p>
      </div>
      <div>
        <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">
          To this address on {chain.name}
        </p>
        <code className="mt-1 block break-all rounded-xl bg-inset p-3 text-xs text-ink">
          {invoice.treasury}
        </code>
      </div>
      <div className="flex justify-center">
        <div className="w-fit rounded-xl bg-white p-3">
          <QRCodeSVG
            value={`ethereum:${invoice.token}@${invoice.chain}/transfer?address=${invoice.treasury}&uint256=${invoice.token_amount || invoice.amount_micros}`}
            size={160}
          />
        </div>
      </div>
      <p className="text-[11px] text-ink-secondary text-center">
        Pay within 30 minutes. Matching late transfers are still credited.{" "}
        {chain.symbol === "$NATION"
          ? "Switch your wallet to Robinhood Chain."
          : "Your wallet may require a separate ETH network fee."}
      </p>
      {status.exempt && (
        <p className="text-[11px] text-ink-secondary text-center">
          Usage is not charged to this account. Test payments still credit the ledger if they complete.
        </p>
      )}
      <button
        className={cn(btn, "w-full py-3")}
        disabled={busy || invoice.expires_at <= Date.now() || Boolean(hash)}
        onClick={onPay}
      >
        Pay with wallet
      </button>
      <div>
        <label className="mb-1 block text-[13px] text-ink-secondary">
          Already paid? Paste your transaction hash
        </label>
        <input
          className={field}
          value={hash}
          onChange={(e) => onHash(e.target.value)}
          placeholder="0x…"
          spellCheck={false}
        />
      </div>
      <button
        className={cn(btn, "w-full")}
        disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hash.trim())}
        onClick={onConfirm}
      >
        I've paid — confirm
      </button>
      {hash && (
        <p className="text-center text-[11px] text-ink-secondary">
          Waiting for network confirmations. You can check again without sending another payment.
        </p>
      )}
    </div>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────────────
/** Owns the credit status and the starter sheet for the whole app, so the account
 * menu and Settings see the same status as the strip. Mount inside StoreProvider. */
export function NationCreditsProvider({ children }: { children: ReactNode }) {
  const { state } = useStore();
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [starterOpen, setStarterOpen] = useState(false);
  const isPlansPage = isFullPlansPath(window.location.pathname, BASE_URL);

  const refresh = useCallback(async () => {
    setStatus(await api("/api/credits/status"));
  }, []);

  useEffect(() => {
    if (!state.connected) return;
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), starterOpen || isPlansPage ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [state.connected, starterOpen, isPlansPage, refresh]);

  const openStarter = useCallback(() => setStarterOpen(true), []);
  const closeStarter = useCallback(() => setStarterOpen(false), []);
  const value = useMemo(
    () => ({ status, refresh, starterOpen, openStarter, closeStarter, openSubscription: goToFullPlans }),
    [status, refresh, starterOpen, openStarter, closeStarter],
  );
  return <NationCreditsCtx.Provider value={value}>{children}</NationCreditsCtx.Provider>;
}

// ─── Main component ───────────────────────────────────────────────────────────
/** Top strip + starter-credit sheet in the chat shell, Full Plans on /subscription. */
export function NationCredits() {
  const { status, refresh, starterOpen, openStarter, closeStarter } = useNationCredits();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [hash, setHash] = useState("");
  const [selectedTier, setSelectedTier] = useState<number | null>(null);

  // Lazily initialize payWithNation from ?asset= URL param.
  const [payWithNation, setPayWithNation] = useState(() => {
    try {
      const asset = new URLSearchParams(window.location.search).get("asset");
      return /^(\$?nation)$/i.test(asset ?? "");
    } catch { return false; }
  });

  // Navigation to and from Full Plans is always a full page load, so this is
  // stable for the life of the component.
  const isPlansPage = isFullPlansPath(window.location.pathname, BASE_URL);

  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const checkoutRef = useRef<HTMLDivElement>(null);
  // Pending deep-link pack: consumed on first status load.
  const deepLinkPackRef = useRef<number | null>(null);

  // Keep the open payment request in step with each status poll (paid_tx arrives this way).
  useEffect(() => {
    if (!status) return;
    setInvoice((cur) =>
      cur ? (status.invoices.find((i) => i.id === cur.id) ?? cur) : null,
    );
  }, [status]);

  // ?pack= deep link: Full Plans starts that pack's checkout once status loads;
  // anywhere else forwards to Full Plans with the same query.
  useEffect(() => {
    try {
      const pack = Number(new URLSearchParams(window.location.search).get("pack"));
      if (!Number.isInteger(pack) || pack <= 0) return;
      if (isPlansPage) deepLinkPackRef.current = pack;
      else window.location.replace(FULL_PLANS_HREF + window.location.search);
    } catch { /* ignore */ }
  }, [isPlansPage]);

  useEffect(() => {
    if (starterOpen) closeRef.current?.focus();
  }, [starterOpen]);

  // Keyboard close + focus trap for the starter sheet
  useEffect(() => {
    if (!starterOpen || isPlansPage) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) closeStarter();
      if (e.key === "Tab" && sheetRef.current) {
        const els = [
          ...sheetRef.current.querySelectorAll<HTMLElement>(
            "a[href],button:not(:disabled),input:not(:disabled)",
          ),
        ];
        const first = els[0], last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [starterOpen, busy, isPlansPage, closeStarter]);

  // Escape on Full Plans steps back from checkout to the packs
  useEffect(() => {
    if (!isPlansPage || !invoice) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setInvoice(null);
        setHash("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isPlansPage, invoice, busy]);

  // Checkout replaces the packs in place: bring the steps and the payment into
  // view, and move focus to the payment heading.
  const checkoutId = invoice?.id;
  useEffect(() => {
    if (!isPlansPage || !checkoutId) return;
    checkoutRef.current?.scrollIntoView?.({ block: "start" });
    checkoutRef.current?.querySelector<HTMLElement>("h2")?.focus();
  }, [isPlansPage, checkoutId]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const verify = () =>
    run(async () => {
      const wallet = await injectedWallet();
      const [address] = await wallet.requestAddresses();
      if (!address) throw new Error("Choose a wallet account.");
      const challenge = await api("/api/credits/wallet/challenge", {
        method: "POST",
        body: JSON.stringify({ address }),
      });
      const signature = await wallet.signMessage({
        account: address,
        message: challenge.message,
      });
      await api("/api/credits/wallet/verify", {
        method: "POST",
        body: JSON.stringify({ challengeId: challenge.challengeId, signature }),
      });
    });

  const createInvoice = (packUsd: number, useNation: boolean) =>
    run(async () => {
      const body = invoiceRequest(status?.chains ?? [], useNation, packUsd);
      if (!body) throw new Error("No payment network available for the selected currency.");
      const inv: Invoice = await api("/api/credits/invoices", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setInvoice(inv);
      setHash("");
    });

  const pay = () =>
    run(async () => {
      if (!invoice || invoice.expires_at <= Date.now())
        throw new Error(
          "Create a new payment request. A matching payment already sent can still be credited.",
        );
      const wallet = await injectedWallet();
      const { defineChain, encodeFunctionData, parseAbi } = await import("viem");
      const transferAbi = parseAbi([
        "function transfer(address to, uint256 amount) returns (bool)",
      ]);
      const chainMeta = status ? chainFor(invoice, status.chains) : undefined;
      const rpcUrl =
        invoice.chain === 8453
          ? "https://mainnet.base.org"
          : "https://rpc.mainnet.chain.robinhood.com";
      const chain = defineChain({
        id: invoice.chain,
        name: chainMeta?.name ?? (invoice.chain === 8453 ? "Base" : "Robinhood Chain"),
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      });
      try {
        await wallet.switchChain({ id: chain.id });
      } catch (err) {
        const code =
          (err as { code?: number; cause?: { code?: number } }).cause?.code ??
          (err as { code?: number }).code;
        if (code !== 4902) throw err;
        await wallet.addChain({ chain });
        await wallet.switchChain({ id: chain.id });
      }
      const [account] = await wallet.requestAddresses();
      if (!account) throw new Error("Choose a wallet account.");
      const transferAmount = invoice.token_amount
        ? BigInt(invoice.token_amount)
        : BigInt(invoice.amount_micros);
      const tx = await wallet.sendTransaction({
        account,
        chain,
        to: invoice.token as Hex,
        data: encodeFunctionData({
          abi: transferAbi,
          functionName: "transfer",
          args: [invoice.treasury as Hex, transferAmount],
        }),
      });
      setHash(tx);
    });

  const confirm = () =>
    run(async () => {
      if (!invoice) return;
      await api("/api/credits/confirm", {
        method: "POST",
        body: JSON.stringify({ invoiceId: invoice.id, txHash: hash.trim() }),
      });
    });

  // Apply deep-link pack once status arrives.
  useEffect(() => {
    if (!status || deepLinkPackRef.current === null) return;
    const pack = deepLinkPackRef.current;
    deepLinkPackRef.current = null;
    if (!status.verified || !status.topUpEnabled || !status.packs.includes(pack)) return;
    setSelectedTier(pack);
    void createInvoice(pack, payWithNation && nationPayable(status));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const hasNation = nationPayable(status);
  const nonNationSymbol =
    status?.chains.find((c) => c.symbol !== "$NATION")?.symbol ?? "USDG";
  const tiers: CreditTier[] = status?.tiers ?? [];
  const stage = invoice ? (invoice.paid_tx ? 3 : 2) : 1;
  const backToPacks = () => { setInvoice(null); setHash(""); };

  return (
    <>
      {/* ── Full Plans (/subscription) ───────────────────────────────────── */}
      {isPlansPage && (
        <div className="fixed inset-0 z-[90] overflow-auto bg-app">
          {/* Sticky nav */}
          <nav className="sticky top-0 z-10 flex items-center gap-3 border-b border-hairline/30 bg-panel/95 px-5 py-3 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => {
                if (window.history.length > 1) window.history.back();
                else window.location.assign(BASE_URL);
              }}
              className="rounded-lg px-2 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              ← Back
            </button>
            <span className="flex-1 text-center text-[13px] font-semibold text-ink">
              Full Plans
            </span>
            {status && (
              <span className="text-[12px] text-ink-secondary">
                {status.exempt
                  ? "Owner / admin"
                  : `$${status.balanceUsd.toFixed(2)} balance`}
              </span>
            )}
          </nav>

          <main className="mx-auto w-full max-w-5xl px-4 pb-24 pt-6 sm:px-6 sm:pt-10">
            <FullPlansHero status={status} />

            <div className="mx-auto mt-10 max-w-4xl">
              {!status ? (
                <div className="flex h-32 items-center justify-center">
                  <span className="text-[13px] text-ink-secondary">Loading plans…</span>
                </div>
              ) : !status.verified ? (
                <div className="mx-auto max-w-md space-y-5 rounded-3xl border border-hairline bg-panel p-6 text-center">
                  <div>
                    <h2 className="text-[22px] font-bold text-ink">Verify your account</h2>
                    <p className="mt-2 text-[14px] text-ink-secondary">{status.starterMessage}</p>
                  </div>
                  <p className="text-[13px] text-ink-secondary">
                    Sign in with your verified email, or verify a wallet with a free signature. No payment is needed to start.
                  </p>
                  <button className={cn(btn, "mx-auto block")} disabled={busy} onClick={() => void verify()}>
                    Verify wallet for starter credit
                  </button>
                </div>
              ) : !status.topUpEnabled ? (
                <p className="text-center text-[15px] text-ink-secondary">Top up coming soon</p>
              ) : (
                <div ref={checkoutRef} className="scroll-mt-20">
                  <CheckoutSteps stage={stage} />
                  {status.exempt && !invoice && (
                    <p className="mt-4 text-center text-[12px] text-ink-secondary">
                      Usage is not charged to this account. Test payments still credit the ledger.
                    </p>
                  )}

                  {invoice ? (
                    <div className="mx-auto mt-8 max-w-xl">
                      <CheckoutPanel
                        invoice={invoice}
                        status={status}
                        busy={busy}
                        hash={hash}
                        onHash={setHash}
                        onPay={() => void pay()}
                        onConfirm={() => void confirm()}
                        onBack={backToPacks}
                      />
                    </div>
                  ) : (
                    <>
                      {hasNation && (
                        <div className="mt-8">
                          <TokenToggle
                            payWithNation={payWithNation}
                            hasNation={hasNation}
                            nonNationSymbol={nonNationSymbol}
                            nationDiscount={status.nationDiscount}
                            onChange={setPayWithNation}
                            disabled={busy}
                          />
                        </div>
                      )}

                      <div className="mt-10 grid gap-5 sm:grid-cols-3">
                        {tiers.map((tier) => (
                          <TierCard
                            key={tier.id}
                            tier={tier}
                            selected={selectedTier === null ? tier.popular : selectedTier === tier.usd}
                            payWithNation={payWithNation && hasNation}
                            nationPriceUsd={status.nationPriceUsd}
                            nonNationSymbol={nonNationSymbol}
                            onSelect={() => {
                              setSelectedTier(tier.usd);
                              void createInvoice(tier.usd, payWithNation && hasNation);
                            }}
                            disabled={busy}
                          />
                        ))}
                      </div>

                      <PendingInvoices
                        rows={pendingInvoiceRows(status.invoices, status.chains)}
                        onResume={(i) => { setInvoice(i); setHash(""); }}
                        disabled={busy}
                      />

                      <p className="mt-8 text-center text-[11px] text-ink-secondary">
                        Credits never expire by time — only when spent.
                      </p>
                    </>
                  )}
                </div>
              )}

              {/* Errors shown in page */}
              {error && (
                <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-2 text-[13px] text-danger text-center">
                  {error}
                </p>
              )}
              {busy && (
                <p role="status" className="mt-4 text-center text-[13px] text-ink-secondary">
                  Please wait…
                </p>
              )}
            </div>
          </main>
        </div>
      )}

      {/* ── Top low-balance / unverified strip (not on Full Plans) ───────── */}
      {status && !isPlansPage && (
        <NationCreditsStrip status={status} onStarter={openStarter} />
      )}

      {/* ── Starter-credit sheet (not on Full Plans) ─────────────────────── */}
      {starterOpen && !isPlansPage && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) closeStarter();
          }}
        >
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="nation-starter-title"
            className="w-full max-w-xl rounded-t-3xl bg-panel text-ink shadow-2xl"
            style={{ maxHeight: "92dvh", overflowY: "auto" }}
          >
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-hairline/60" />
            </div>

            <div className="px-5 pb-8 pt-2">
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 id="nation-starter-title" className="text-xl font-semibold">
                  Get free starter credit
                </h2>
                <button
                  ref={closeRef}
                  onClick={closeStarter}
                  disabled={busy}
                  aria-label="Close"
                  className="flex size-8 items-center justify-center rounded-full hover:bg-raised text-ink-secondary hover:text-ink"
                >
                  ✕
                </button>
              </div>

              {!status ? null : !status.verified ? (
                <div className="space-y-4">
                  <p className="text-[14px] text-ink-secondary">{status.starterMessage}</p>
                  <p className="text-[13px] text-ink-secondary">
                    Sign in with your verified email, or verify a wallet with a free signature.
                    No payment is needed to start.
                  </p>
                  <button
                    className={cn(btn, "w-full")}
                    disabled={busy}
                    onClick={() => void verify()}
                  >
                    Verify wallet for starter credit
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <p className="text-[14px] font-medium text-ink">Your account is verified.</p>
                  <p className="text-[14px] text-ink-secondary">{status.starterMessage}</p>
                  {status.topUpEnabled && (
                    <a className={cn(btn, "block w-full text-center")} href={FULL_PLANS_HREF}>
                      See Full Plans
                    </a>
                  )}
                </div>
              )}

              {busy && (
                <p role="status" className="mt-4 text-center text-[13px] text-ink-secondary">
                  Please wait…
                </p>
              )}
              {error && (
                <p role="alert" className="mt-4 rounded-xl bg-danger/10 px-4 py-2 text-[13px] text-danger">
                  {error}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Settings row (exported for UsageSection) ─────────────────────────────────
/** Settings → Usage row. "Top up" is a link to Full Plans. */
export function NationCreditsSettingsRow() {
  const { status } = useNationCredits();
  if (!status) return null;
  return (
    <SettingRow
      title="Billing & Credits"
      subtitle={
        status.topUpEnabled
          ? "Add credit for your team's API usage."
          : status.topUpMessage || "Top up coming soon"
      }
    >
      {status.topUpEnabled ? (
        <a className="ui-button hover:bg-raised-hover" href={FULL_PLANS_HREF}>
          Top up
        </a>
      ) : (
        <span className="text-[13px] text-ink-secondary">
          {status.topUpMessage || "Coming soon"}
        </span>
      )}
    </SettingRow>
  );
}
