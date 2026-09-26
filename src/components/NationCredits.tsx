/**
 * Nation credit top-up UX.
 *
 * Entry points:
 *   – /subscription → full-page Plans screen (founder-preferred primary surface)
 *   – /subscription?pack=15|49|99 → auto-opens checkout for that pack
 *   – /subscription?asset=USDG|NATION → pre-selects pay token
 *   – Bottom-left account chip (SidebarProfileMenu) → openSheet() → bottom sheet
 *   – Top banner "Top up" link → openSheet() → bottom sheet
 *   – Settings → Usage "NationCreditsSettingsRow" → openSubscription() → /subscription
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { EIP1193Provider, Hex } from "viem";
import { api, useStore } from "@/state/store";
import { NationCreditsCtx, useNationCredits, type CreditStatus, type CreditTier } from "@/lib/nation-credits-ctx";
import { SettingRow } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

// Module-level constant so subscription path is stable across renders.
// import.meta.env.BASE_URL is "/swarm/" in Vite dev, "/" on the live VPS.
const SUBSCRIPTION_PATH = (import.meta.env.BASE_URL + "subscription").replace(/\/\//g, "/");

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
/** Top banner shown in the chat shell. `onOpen` is called when the user clicks
 * any credit action. Hidden automatically on the /subscription full page. */
export function NationCreditsStrip({ status, onOpen }: { status: StripStatus; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 border-b border-hairline/30 bg-panel px-4 py-2 text-xs text-ink">
      <span>{status.exempt ? "NATION API" : status.label}</span>
      {status.lowBalance && status.verified && (
        <span>Your teammates are ready when you are. Add credit to keep going.</span>
      )}
      {!status.verified && (
        <button className="underline" onClick={onOpen}>
          Get free starter credit
        </button>
      )}
      {status.topUpEnabled ? (
        <button className="font-medium underline" onClick={onOpen}>
          Top up
        </button>
      ) : !status.exempt ? (
        <span>{status.topUpMessage}</span>
      ) : status.topUpMessage ? (
        <span className="text-ink-secondary">{status.topUpMessage}</span>
      ) : null}
    </div>
  );
}

// ─── Tier card ───────────────────────────────────────────────────────────────
/** Exported for unit tests. Tapping the card calls onSelect directly — no
 * separate "Pay" button is required at the parent level. */
export function TierCard({
  tier,
  selected,
  payWithNation,
  nationPriceUsd,
  nationDiscount,
  nonNationSymbol,
  onSelect,
  disabled,
}: {
  tier: CreditTier;
  selected: boolean;
  payWithNation: boolean;
  nationPriceUsd: number | null;
  nationDiscount: number | null;
  nonNationSymbol: string;
  onSelect: () => void;
  disabled: boolean;
}) {
  const usdLabel = `$${tier.usd}`;
  const discountPct = nationDiscount ? Math.round(nationDiscount * 100) : 20;

  const nationAmount =
    nationPriceUsd && nationPriceUsd > 0
      ? (tier.usd / nationPriceUsd).toFixed(2)
      : null;
  const nationLabel = nationAmount ? `${nationAmount} $NATION` : null;

  const primaryPrice = payWithNation && nationLabel ? nationLabel : usdLabel;

  // Secondary price shows the alternative token when both are available.
  const secondaryPrice =
    nationLabel && payWithNation
      ? `= ${usdLabel} value`
      : nationLabel
        ? `≈ ${nationLabel} · save ~${discountPct}%`
        : null;

  const ctaLabel = payWithNation
    ? `Pay ${primaryPrice} in $NATION`
    : `Pay ${usdLabel} with ${nonNationSymbol}`;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "relative flex flex-col gap-3 rounded-2xl border p-5 text-left transition-all",
        selected
          ? "border-accent bg-accent/8 shadow-sm ring-1 ring-accent/40"
          : "border-hairline/60 bg-panel hover:border-accent/40 hover:bg-raised/50",
        disabled && "opacity-50 pointer-events-none",
      )}
    >
      {tier.popular && (
        <span className="absolute -top-2.5 right-4 rounded-full bg-accent px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-ink">
          Most popular
        </span>
      )}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[15px] font-semibold text-ink">{tier.name}</p>
          <p className="mt-0.5 text-[22px] font-bold text-ink">{primaryPrice}</p>
          {secondaryPrice && (
            <p className="mt-0.5 text-[12px] font-medium text-accent">{secondaryPrice}</p>
          )}
        </div>
        {payWithNation && (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
            Save ~{discountPct}%
          </span>
        )}
      </div>
      <p className="text-[12px] text-ink-secondary">
        ${tier.creditUsd} permanent credit · never expires
      </p>
      <div
        className={cn(
          "mt-1 w-full rounded-xl py-2.5 text-center text-[13px] font-semibold",
          selected
            ? "bg-accent text-accent-ink"
            : "bg-raised/70 text-ink hover:bg-raised",
        )}
      >
        {ctaLabel}
      </div>
    </button>
  );
}

// ─── Payment token toggle ─────────────────────────────────────────────────────
/** Shown only when ≥2 payable symbols exist (hasNation = true). */
export function TokenToggle({
  payWithNation,
  hasNation,
  nonNationSymbol,
  nationDiscount,
  onChange,
}: {
  payWithNation: boolean;
  hasNation: boolean;
  nonNationSymbol: string;
  nationDiscount: number | null;
  onChange: (nation: boolean) => void;
}) {
  if (!hasNation) return null;
  const discountPct = nationDiscount ? Math.round(nationDiscount * 100) : 20;
  return (
    <div className="flex items-center justify-center gap-1 rounded-xl border border-hairline/50 bg-inset p-1 text-sm">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[13px] font-medium transition-colors",
          payWithNation ? "bg-panel text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
        )}
      >
        <span className="font-semibold text-accent">$NATION</span>
        <span className="rounded-full bg-accent/15 px-1.5 py-px text-[10px] font-semibold text-accent">
          Save ~{discountPct}%
        </span>
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={cn(
          "flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[13px] font-medium transition-colors",
          !payWithNation ? "bg-panel text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
        )}
      >
        {nonNationSymbol}
      </button>
    </div>
  );
}

// ─── Checkout panel (shared between sheet and modal) ─────────────────────────
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
  const chain = status.chains.find((c) => c.id === invoice.chain && c.token === invoice.token);
  const paid = Boolean(invoice.paid_tx);
  const isNation = chain?.symbol === "$NATION";
  const displaySymbol = chain?.symbol ?? "USDG";
  const displayAmount =
    isNation && invoice.token_amount
      ? (Number(BigInt(invoice.token_amount)) / 1e18).toFixed(6)
      : (invoice.amount_micros / 1e6).toFixed(6);
  const networkName = chain?.name ?? "Robinhood Chain";

  const packUsd = invoice.pack_micros / 1_000_000;
  const tierInfo = status.tiers.find((t) => t.usd === packUsd);
  const tierName = tierInfo?.name ?? `$${packUsd}`;

  return (
    <div className="space-y-4 rounded-2xl bg-inset p-5">
      {paid ? (
        <p role="status" className="text-center text-[15px] font-medium text-accent">
          ✓ Payment verified. Your credit is ready.
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-ink">Send payment</h3>
            <button
              type="button"
              onClick={onBack}
              disabled={busy}
              className="text-[13px] text-ink-secondary hover:text-ink"
            >
              ← Back
            </button>
          </div>

          {/* Order summary */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl bg-panel px-3 py-2 text-[13px]">
            <span className="font-semibold text-ink">{tierName} pack</span>
            <span className="text-hairline/60">·</span>
            <span className="font-semibold text-ink">{displayAmount} {displaySymbol}</span>
            <span className="text-hairline/60">·</span>
            <span className="text-ink-secondary">{networkName}</span>
          </div>

          <div className="rounded-xl bg-panel p-3 text-[13px] space-y-1">
            <p className="font-semibold text-ink">
              Send exactly {displayAmount} {displaySymbol}
            </p>
            <p className="text-xs text-ink-secondary">
              The unique amount identifies your payment — the full amount is credited.
            </p>
          </div>
          <code className="block break-all rounded-xl bg-panel p-3 text-xs text-ink">
            {invoice.treasury}
          </code>
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
            {isNation
              ? "Switch your wallet to Robinhood Chain."
              : "Your wallet may require a separate ETH network fee."}
          </p>
          {status.exempt && (
            <p className="text-[11px] text-ink-secondary text-center">
              Usage is not charged to this account. Test payments still credit the ledger if they complete.
            </p>
          )}
          <button
            className={cn(btn, "w-full")}
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
        </>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
/** Top-strip + bottom sheet (inline triggers) or full-page (/subscription).
 * Provides NationCreditsCtx for the rest of the tree. */
export function NationCredits() {
  const { state } = useStore();
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [hash, setHash] = useState("");
  const [selectedTier, setSelectedTier] = useState<number>(15);

  // Lazily initialize payWithNation from ?asset= URL param.
  const [payWithNation, setPayWithNation] = useState(() => {
    try {
      const asset = new URLSearchParams(window.location.search).get("asset");
      return /^(\$?nation)$/i.test(asset ?? "");
    } catch { return false; }
  });

  // Detect subscription page mode. Navigation to/from /subscription is always
  // a full page reload (window.location.assign), so this is stable per session.
  const isSubscriptionPage =
    window.location.pathname === SUBSCRIPTION_PATH ||
    window.location.pathname === SUBSCRIPTION_PATH + "/";

  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  // Pending deep-link pack: consumed on first status load.
  const deepLinkPackRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const value: CreditStatus = await api("/api/credits/status");
    setStatus(value);
    setInvoice((cur) =>
      cur ? (value.invoices.find((i) => i.id === cur.id) ?? cur) : null,
    );
  }, []);

  useEffect(() => {
    if (!state.connected) return;
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), open || isSubscriptionPage ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [state.connected, open, isSubscriptionPage, refresh]);

  // Parse ?pack= deep-link param (bottom sheet only; subscription page handles it separately).
  useEffect(() => {
    if (isSubscriptionPage) return;
    try {
      const path = window.location.pathname;
      // /subscription path detection for bottom-sheet fallback (e.g. old bookmarks without the full-page support)
      if (path === SUBSCRIPTION_PATH || path === SUBSCRIPTION_PATH + "/") return;
      const pack = new URLSearchParams(window.location.search).get("pack");
      if (pack) {
        const n = Number(pack);
        if (Number.isInteger(n) && n > 0) {
          deepLinkPackRef.current = n;
          setOpen(true);
        }
      }
    } catch { /* ignore */ }
  }, [isSubscriptionPage]);

  // On the subscription page, parse ?pack= and open it.
  useEffect(() => {
    if (!isSubscriptionPage) return;
    try {
      const pack = new URLSearchParams(window.location.search).get("pack");
      if (pack) {
        const n = Number(pack);
        if (Number.isInteger(n) && n > 0) deepLinkPackRef.current = n;
      }
    } catch { /* ignore */ }
  }, [isSubscriptionPage]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  // Keyboard close + focus trap for bottom sheet
  useEffect(() => {
    if (!open || isSubscriptionPage) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setOpen(false);
      if (e.key === "Tab" && sheetRef.current) {
        const els = [
          ...sheetRef.current.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled)",
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
  }, [open, busy, isSubscriptionPage]);

  // Keyboard close for subscription page modal
  useEffect(() => {
    if (!isSubscriptionPage || !invoice) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setInvoice(null);
        setHash("");
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isSubscriptionPage, invoice, busy]);

  const openSheet = useCallback(() => setOpen(true), []);
  const closeSheet = useCallback(() => setOpen(false), []);
  const openSubscription = useCallback(() => {
    window.location.assign(SUBSCRIPTION_PATH);
  }, []);

  // Auto-open the credits sheet when the SPA is served at /subscription
  // (vercel.json rewrites /subscription → /swarm/index.html).
  useEffect(() => {
    const { pathname } = window.location;
    if (pathname === "/subscription" || pathname === "/subscription/") {
      setOpen(true);
    }
  }, []);

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

  // Find the best chain for the current token selection.
  const resolveChain = (useNation: boolean): Chain | undefined => {
    if (!status) return undefined;
    if (useNation) return status.chains.find((c) => c.symbol === "$NATION");
    return status.chains.find((c) => c.symbol !== "$NATION");
  };

  const createInvoice = (tierUsd: number, useNation = payWithNation) =>
    run(async () => {
      const chain = resolveChain(useNation);
      if (!chain) throw new Error("No payment network available for the selected currency.");
      const inv: Invoice = await api("/api/credits/invoices", {
        method: "POST",
        body: JSON.stringify({ chain: chain.id, packUsd: tierUsd }),
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
      const chainMeta = status?.chains.find((c) => c.id === invoice.chain && c.token === invoice.token);
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
    if (!status.verified || !status.topUpEnabled || !status.packs.includes(pack)) {
      deepLinkPackRef.current = null;
      return;
    }
    const hasNationChain =
      status.chains.some((c) => c.symbol === "$NATION") && status.nationPriceUsd != null;
    const useNation = payWithNation && hasNationChain;
    if (payWithNation && !hasNationChain) setPayWithNation(false);
    deepLinkPackRef.current = null;
    setSelectedTier(pack);
    void createInvoice(pack, useNation);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // $NATION option requires both a chain entry AND a configured price.
  const hasNation = Boolean(
    status?.chains.some((c) => c.symbol === "$NATION") && status.nationPriceUsd != null,
  );
  const nonNationSymbol =
    status?.chains.find((c) => c.symbol !== "$NATION")?.symbol ?? "USDG";
  const tiers: CreditTier[] = status?.tiers ?? [];

  // ── Shared plan picker JSX ────────────────────────────────────────────────
  const planPicker = (
    <div className="space-y-5">
      <TokenToggle
        payWithNation={payWithNation}
        hasNation={hasNation}
        nonNationSymbol={nonNationSymbol}
        nationDiscount={status?.nationDiscount ?? null}
        onChange={setPayWithNation}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        {tiers.map((tier) => (
          <TierCard
            key={tier.id}
            tier={tier}
            selected={selectedTier === tier.usd}
            payWithNation={payWithNation && hasNation}
            nationPriceUsd={status?.nationPriceUsd ?? null}
            nationDiscount={status?.nationDiscount ?? null}
            nonNationSymbol={nonNationSymbol}
            onSelect={() => {
              setSelectedTier(tier.usd);
              void createInvoice(tier.usd);
            }}
            disabled={busy}
          />
        ))}
      </div>

      {status?.invoices.some((i) => !i.paid_tx) && (
        <div className="space-y-1.5 pt-1">
          <p className="text-[12px] font-medium text-ink-secondary">
            Resume a pending payment
          </p>
          {status.invoices
            .filter((i) => !i.paid_tx)
            .map((i) => {
              const c = status.chains.find((ch) => ch.id === i.chain);
              const isN = c?.symbol === "$NATION";
              const amt =
                isN && i.token_amount
                  ? (Number(BigInt(i.token_amount)) / 1e18).toFixed(4)
                  : (i.amount_micros / 1e6).toFixed(4);
              return (
                <button
                  key={i.id}
                  className="block w-full rounded-xl border border-hairline/40 bg-inset px-3 py-2 text-left text-[12px] text-ink hover:bg-raised/50"
                  onClick={() => { setInvoice(i); setHash(""); }}
                >
                  {amt} {c?.symbol ?? "?"} · expires{" "}
                  {new Date(i.expires_at).toLocaleTimeString()}
                </button>
              );
            })}
        </div>
      )}

      <p className="text-center text-[11px] text-ink-secondary">
        Credits never expire by time — only when spent.
      </p>
    </div>
  );

  return (
    <NationCreditsCtx.Provider value={{ status, open, openSheet, closeSheet, openSubscription }}>

      {/* ── Full-page /subscription layout ──────────────────────────────── */}
      {isSubscriptionPage && (
        <div className="fixed inset-0 z-[90] overflow-auto bg-app">
          {/* Sticky nav */}
          <nav className="sticky top-0 z-10 flex items-center gap-3 border-b border-hairline/30 bg-panel/95 px-5 py-3 backdrop-blur-sm">
            <button
              type="button"
              onClick={() => {
                if (window.history.length > 1) window.history.back();
                else window.location.assign(import.meta.env.BASE_URL ?? "/");
              }}
              className="rounded-lg px-2 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
            >
              ← Back
            </button>
            <span className="flex-1 text-center text-[13px] font-semibold text-ink">
              Plans
            </span>
            {status && (
              <span className="text-[12px] text-ink-secondary">
                {status.exempt
                  ? "Owner / admin"
                  : `$${status.balanceUsd.toFixed(2)} balance`}
              </span>
            )}
          </nav>

          {/* Main content */}
          <main className="mx-auto w-full max-w-3xl px-5 pb-20 pt-10">
            {!status ? (
              <div className="flex h-32 items-center justify-center">
                <span className="text-[13px] text-ink-secondary">Loading plans…</span>
              </div>
            ) : !status.verified ? (
              <div className="mx-auto max-w-md space-y-5 text-center">
                <div>
                  <h1 className="text-[26px] font-bold text-ink">Verify your account</h1>
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
              <>
                {/* Hero */}
                <div className="mb-10 text-center">
                  <h1 className="text-[30px] font-bold tracking-tight text-ink sm:text-[36px]">
                    Plans
                  </h1>
                  <p className="mt-2 text-[15px] text-ink-secondary">
                    Prepaid AI credits for your whole team.
                  </p>
                  <p className="mt-0.5 text-[13px] text-ink-secondary">
                    No subscriptions · no expiry · pay only when you choose.
                  </p>
                  {status.exempt && (
                    <p className="mt-2 text-[12px] text-ink-secondary">
                      Usage is not charged to this account. Test payments still credit the ledger.
                    </p>
                  )}
                </div>

                {/* Token toggle centered */}
                {hasNation && (
                  <div className="mb-8 flex justify-center">
                    <TokenToggle
                      payWithNation={payWithNation}
                      hasNation={hasNation}
                      nonNationSymbol={nonNationSymbol}
                      nationDiscount={status.nationDiscount}
                      onChange={setPayWithNation}
                    />
                  </div>
                )}

                {/* Tier cards */}
                <div className="grid gap-4 sm:grid-cols-3">
                  {tiers.map((tier) => (
                    <TierCard
                      key={tier.id}
                      tier={tier}
                      selected={selectedTier === tier.usd && !invoice}
                      payWithNation={payWithNation && hasNation}
                      nationPriceUsd={status.nationPriceUsd}
                      nationDiscount={status.nationDiscount}
                      nonNationSymbol={nonNationSymbol}
                      onSelect={() => {
                        setSelectedTier(tier.usd);
                        void createInvoice(tier.usd);
                      }}
                      disabled={busy}
                    />
                  ))}
                </div>

                {/* Resume pending invoices */}
                {status.invoices.some((i) => !i.paid_tx) && (
                  <div className="mt-8 space-y-1.5">
                    <p className="text-[12px] font-medium text-ink-secondary">Resume a pending payment</p>
                    {status.invoices
                      .filter((i) => !i.paid_tx)
                      .map((i) => {
                        const c = status.chains.find((ch) => ch.id === i.chain);
                        const isN = c?.symbol === "$NATION";
                        const amt = isN && i.token_amount
                          ? (Number(BigInt(i.token_amount)) / 1e18).toFixed(4)
                          : (i.amount_micros / 1e6).toFixed(4);
                        return (
                          <button
                            key={i.id}
                            className="block w-full rounded-xl border border-hairline/40 bg-inset px-3 py-2 text-left text-[12px] text-ink hover:bg-raised/50"
                            onClick={() => { setInvoice(i); setHash(""); }}
                          >
                            {amt} {c?.symbol ?? "?"} · expires {new Date(i.expires_at).toLocaleTimeString()}
                          </button>
                        );
                      })}
                  </div>
                )}

                <p className="mt-8 text-center text-[11px] text-ink-secondary">
                  Credits never expire by time — only when spent.
                </p>
              </>
            )}

            {/* Errors shown in page */}
            {error && (
              <p role="alert" className="mt-6 rounded-xl bg-danger/10 px-4 py-2 text-[13px] text-danger text-center">
                {error}
              </p>
            )}
            {busy && !invoice && (
              <p role="status" className="mt-4 text-center text-[13px] text-ink-secondary">
                Please wait…
              </p>
            )}
          </main>

          {/* Centered checkout modal */}
          {invoice && (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
              onClick={(e) => {
                if (e.target === e.currentTarget && !busy) {
                  setInvoice(null);
                  setHash("");
                }
              }}
            >
              <div
                className="w-full max-w-md overflow-auto rounded-3xl bg-panel shadow-2xl"
                style={{ maxHeight: "90dvh" }}
              >
                <div className="p-1">
                  <CheckoutPanel
                    invoice={invoice}
                    status={status!}
                    busy={busy}
                    hash={hash}
                    onHash={setHash}
                    onPay={() => void pay()}
                    onConfirm={() => void confirm()}
                    onBack={() => { setInvoice(null); setHash(""); }}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Top low-balance / unverified strip (not on /subscription) ───── */}
      {status && !isSubscriptionPage && (
        <NationCreditsStrip status={status} onOpen={openSheet} />
      )}

      {/* ── Bottom sheet (inline triggers, not on /subscription) ─────────── */}
      {open && !isSubscriptionPage && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="nation-credit-title"
            className="w-full max-w-xl rounded-t-3xl bg-panel text-ink shadow-2xl"
            style={{ maxHeight: "92dvh", overflowY: "auto" }}
          >
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="h-1 w-10 rounded-full bg-hairline/60" />
            </div>

            <div className="px-5 pb-8 pt-2">
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 id="nation-credit-title" className="text-xl font-semibold">
                  {invoice ? "Complete payment" : "Top up credits"}
                </h2>
                <button
                  ref={closeRef}
                  onClick={closeSheet}
                  disabled={busy}
                  aria-label="Close"
                  className="flex size-8 items-center justify-center rounded-full hover:bg-raised text-ink-secondary hover:text-ink"
                >
                  ✕
                </button>
              </div>

              {status && (
                <div className="mb-5 flex items-center gap-3 rounded-2xl bg-inset px-4 py-3">
                  <div className="flex-1">
                    <p className="text-[13px] text-ink-secondary">Current balance</p>
                    <p className="text-[17px] font-bold text-ink">
                      {status.exempt ? "Owner / admin" : `$${status.balanceUsd.toFixed(2)}`}
                    </p>
                  </div>
                  {!status.verified && (
                    <span className="rounded-full bg-warning/20 px-2.5 py-1 text-[11px] font-medium text-warning">
                      Unverified
                    </span>
                  )}
                </div>
              )}

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
              ) : !status.topUpEnabled ? (
                <p className="text-center text-ink-secondary">Top up coming soon</p>
              ) : invoice ? (
                <CheckoutPanel
                  invoice={invoice}
                  status={status}
                  busy={busy}
                  hash={hash}
                  onHash={setHash}
                  onPay={() => void pay()}
                  onConfirm={() => void confirm()}
                  onBack={() => { setInvoice(null); setHash(""); }}
                />
              ) : (
                <div className="space-y-5">
                  <div>
                    <p className="text-[14px] font-medium text-ink">
                      Power your team with prepaid AI credits.
                    </p>
                    <p className="mt-1 text-[12px] text-ink-secondary">
                      No subscriptions · no expiry · pay only when you choose to top up.
                    </p>
                  </div>
                  {status.exempt && (
                    <p className="text-[12px] text-ink-secondary">
                      Usage is not charged to this account. Test payments still credit the ledger if they complete.
                    </p>
                  )}
                  {planPicker}
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
    </NationCreditsCtx.Provider>
  );
}

// ─── Settings row (exported for UsageSection) ─────────────────────────────────
/** Settings → Usage row. "Top up" navigates to the /subscription Plans page. */
export function NationCreditsSettingsRow() {
  const { status, openSubscription } = useNationCredits();
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
        <button className="ui-button" onClick={openSubscription}>
          Top up
        </button>
      ) : (
        <span className="text-[13px] text-ink-secondary">
          {status.topUpMessage || "Coming soon"}
        </span>
      )}
    </SettingRow>
  );
}
