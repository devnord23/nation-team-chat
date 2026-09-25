/**
 * Nation credit top-up UX.
 *
 * Provides NationCreditsCtx so child components (e.g. SidebarProfileMenu,
 * NationCreditsSettingsRow) can open the sheet and read balance without
 * prop-drilling.
 *
 * Entry points:
 *   – Bottom-left account chip (SidebarProfileMenu) → openSheet()
 *   – Top banner "Top up" link (low-balance / unverified warning)
 *   – Settings → Usage "NationCreditsSettingsRow" → openSheet()
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { EIP1193Provider, Hex } from "viem";
import { api, useStore } from "@/state/store";
import { NationCreditsCtx, useNationCredits, type CreditStatus, type CreditTier } from "@/lib/nation-credits-ctx";
import { SettingRow } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

// ─── style tokens ────────────────────────────────────────────────────────────
const btn =
  "rounded-xl bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-50 transition-opacity";
const field =
  "w-full rounded-xl border border-hairline/50 bg-inset p-3 text-ink focus:outline-none focus:border-accent/60";

// Narrow status type used by the pure strip + the Settings row — matches the
// shape the server has always returned so existing tests keep working.
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
  invoices: Array<{ id: string; chain: number; treasury: string; token: string; amount_micros: number; expires_at: number; paid_tx: string | null }>;
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
/** Top banner shown in the chat shell. Exported so unit tests can render it
 * directly without async state. `onOpen` is called when the user clicks any
 * credit action in the strip. */
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
function TierCard({
  tier,
  selected,
  payWithNation,
  nationPriceUsd,
  onSelect,
  disabled,
}: {
  tier: CreditTier;
  selected: boolean;
  payWithNation: boolean;
  nationPriceUsd: number | null;
  onSelect: () => void;
  disabled: boolean;
}) {
  const usdLabel = `$${tier.usd}`;
  const nationLabel =
    nationPriceUsd && nationPriceUsd > 0
      ? `≈ ${(tier.usd / nationPriceUsd).toFixed(2)} $NATION`
      : `≈ ${Math.round(tier.usd * 0.8)} $NATION`;
  const ctaLabel = payWithNation
    ? `Pay ${nationLabel} worth of $NATION`
    : `Pay ${usdLabel} with USDC`;

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
          <p className="mt-0.5 text-[22px] font-bold text-ink">
            {payWithNation ? nationLabel : usdLabel}
          </p>
        </div>
        {payWithNation && (
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
            Save ~20%
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
function TokenToggle({
  payWithNation,
  hasNation,
  onChange,
}: {
  payWithNation: boolean;
  hasNation: boolean;
  onChange: (nation: boolean) => void;
}) {
  if (!hasNation) return null;
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
          Save ~20%
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
        USDC
      </button>
    </div>
  );
}

// ─── Checkout step ────────────────────────────────────────────────────────────
function CheckoutPanel({
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
  const chain = status.chains.find((c) => c.id === invoice.chain);
  const paid = Boolean(invoice.paid_tx);
  const isNation = chain?.symbol === "$NATION";
  const displaySymbol = chain?.symbol ?? (invoice.chain === 8453 ? "USDC" : "USDG");
  const displayAmount =
    isNation && invoice.token_amount
      ? (Number(BigInt(invoice.token_amount)) / 1e18).toFixed(6)
      : (invoice.amount_micros / 1e6).toFixed(6);

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
          <div className="rounded-xl bg-panel p-3 text-[13px] space-y-1">
            <p className="font-semibold text-ink">
              Send exactly {displayAmount} {displaySymbol}
            </p>
            <p className="text-ink-secondary">
              Network: {chain?.name ?? (invoice.chain === 8453 ? "Base" : "Robinhood Chain")}
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
            Connect wallet and pay
          </button>
          <div>
            <label className="mb-1 block text-[13px] text-ink-secondary">
              Already paid? Paste the transaction hash
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
            Check payment
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
/** Top-strip + bottom sheet. Provides NationCreditsCtx for the rest of the
 * tree (sidebar chip, Settings row) to call openSheet() or read status. */
export function NationCredits() {
  const { state } = useStore();
  const [status, setStatus] = useState<CreditStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [hash, setHash] = useState("");
  const [selectedTier, setSelectedTier] = useState<number>(15);
  const [payWithNation, setPayWithNation] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const value: CreditStatus = await api("/api/credits/status");
    setStatus(value);
    setSelectedTier((cur) =>
      value.packs.includes(cur) ? cur : (value.packs[1] ?? value.packs[0] ?? 15),
    );
    setInvoice((cur) =>
      cur ? (value.invoices.find((i) => i.id === cur.id) ?? cur) : null,
    );
  }, []);

  useEffect(() => {
    if (!state.connected) return;
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), open ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [state.connected, open, refresh]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  // Keyboard close + focus trap
  useEffect(() => {
    if (!open) return;
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
  }, [open, busy]);

  const openSheet = useCallback(() => setOpen(true), []);
  const closeSheet = useCallback(() => setOpen(false), []);

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

  const resolveChain = (useNation: boolean): Chain | undefined => {
    if (!status) return undefined;
    if (useNation) return status.chains.find((c) => c.symbol === "$NATION");
    return status.chains.find((c) => c.symbol === "USDC") ?? status.chains.find((c) => c.id === 8453);
  };

  const createInvoice = (tierUsd: number) =>
    run(async () => {
      const chain = resolveChain(payWithNation);
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
      const chain = defineChain({
        id: invoice.chain,
        name: invoice.chain === 8453 ? "Base" : "Robinhood Chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: {
          default: {
            http: [
              invoice.chain === 8453
                ? "https://mainnet.base.org"
                : "https://rpc.mainnet.chain.robinhood.com",
            ],
          },
        },
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
      // For 18-decimal tokens ($NATION) use token_amount; fall back to amount_micros (USDC/USDG).
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

  const hasNation = Boolean(status?.chains.some((c) => c.symbol === "$NATION"));
  const tiers: CreditTier[] = status?.tiers ?? [];

  return (
    <NationCreditsCtx.Provider value={{ status, open, openSheet, closeSheet }}>
      {/* ── Top low-balance / unverified strip ───────────────────────── */}
      {status && <NationCreditsStrip status={status} onOpen={openSheet} />}

      {/* ── Bottom sheet backdrop + panel ────────────────────────────── */}
      {open && (
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
              {/* header */}
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 id="nation-credit-title" className="text-xl font-semibold">
                  {invoice ? "Complete payment" : "Add credit"}
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

              {/* balance pill */}
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
                /* ── Verify step ─────────────────────────────────────── */
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
                /* ── Checkout step ───────────────────────────────────── */
                <CheckoutPanel
                  invoice={invoice}
                  status={status}
                  busy={busy}
                  hash={hash}
                  onHash={setHash}
                  onPay={() => void pay()}
                  onConfirm={() => void confirm()}
                  onBack={() => {
                    setInvoice(null);
                    setHash("");
                  }}
                />
              ) : (
                /* ── Plan picker step ────────────────────────────────── */
                <div className="space-y-5">
                  <p className="text-[13px] text-ink-secondary">
                    Your credit never expires. You pay only when you choose to top up.
                    No automatic or recurring charges.
                  </p>
                  {status.exempt && (
                    <p className="text-[12px] text-ink-secondary">
                      Usage is not charged to this account. Test payments still credit the ledger if they complete.
                    </p>
                  )}

                  <TokenToggle
                    payWithNation={payWithNation}
                    hasNation={hasNation}
                    onChange={setPayWithNation}
                  />

                  {/* tier cards */}
                  <div className="grid gap-3 sm:grid-cols-3">
                    {tiers.map((tier) => (
                      <TierCard
                        key={tier.id}
                        tier={tier}
                        selected={selectedTier === tier.usd}
                        payWithNation={payWithNation && hasNation}
                        nationPriceUsd={status.nationPriceUsd}
                        onSelect={() => setSelectedTier(tier.usd)}
                        disabled={busy}
                      />
                    ))}
                  </div>

                  <button
                    className={cn(btn, "w-full")}
                    disabled={busy}
                    onClick={() => void createInvoice(selectedTier)}
                  >
                    {payWithNation && hasNation
                      ? `Pay with $NATION · save ~20%`
                      : `Pay with USDC`}
                  </button>

                  {/* resume pending invoices */}
                  {status.invoices.some((i) => !i.paid_tx) && (
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
                              onClick={() => {
                                setInvoice(i);
                                setHash("");
                              }}
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
              )}

              {busy && (
                <p role="status" className="mt-4 text-center text-[13px] text-ink-secondary">
                  Please wait…
                </p>
              )}
              {error && (
                <p
                  role="alert"
                  className="mt-4 rounded-xl bg-danger/10 px-4 py-2 text-[13px] text-danger"
                >
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
/** Settings → Usage row that lets the owner open the same bottom sheet as
 * members. Uses NationCreditsCtx provided by the parent NationCredits. */
export function NationCreditsSettingsRow() {
  const { status, openSheet } = useNationCredits();
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
        <button className="ui-button" onClick={openSheet}>
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
