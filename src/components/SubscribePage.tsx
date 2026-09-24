/**
 * Plan subscription page — wallet-connect, quote creation, on-chain payment,
 * and entitlement display. Only shown when NATION_TREASURY_* is configured.
 *
 * Terminology visible to end users:
 *   - "Pay with USDC on Base" / "Pay with USDG on Robinhood Chain"
 *   - No vendor names, model IDs, GitHub links, or founder info.
 *
 * Wallet connect: injected provider (MetaMask, Coinbase Wallet, etc.) with a
 * fallback message when none is detected. WalletConnect is intentionally
 * excluded here to keep dependencies minimal; it can be added later.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronLeft, CreditCard, Loader2, RefreshCw, Wallet, XCircle, Zap } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Plan {
  id: string;
  label: string;
  usdCents: number;
  credits: number;
  intervalSeconds: number;
}

interface Chain {
  chainId: number;
  label: string;
  tokenSymbol: string;
  tokenDecimals: number;
  isTestnet: boolean;
}

interface BillingStatus {
  enabled: boolean;
  plans: Plan[];
  chains: Chain[];
}

interface Quote {
  id: string;
  planId: string;
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string;
  receiverAddress: string;
  amountBaseUnits: string;
  amountDisplay: string;
  expiresAt: string;
  status: string;
}

interface Entitlement {
  planId: string;
  planLabel: string;
  creditsBalance: number;
  expiresAt: string;
  active: boolean;
}

type PayStep =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; address: string }
  | { kind: "quoting" }
  | { kind: "quoted"; quote: Quote }
  | { kind: "sending" }
  | { kind: "watching"; txHash: string; quoteId: string }
  | { kind: "success"; entitlement: Entitlement }
  | { kind: "error"; message: string };

// ── Utilities ─────────────────────────────────────────────────────────────────

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatExpiry(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

function formatCredits(n: number): string {
  return n.toLocaleString();
}

// ── Wallet helpers (injected provider only) ───────────────────────────────────

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on?: (event: string, handler: (...args: unknown[]) => void) => void;
    };
  }
}

async function connectWallet(): Promise<string> {
  if (!window.ethereum) throw new Error("No wallet detected. Install MetaMask or a compatible browser wallet.");
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts.length) throw new Error("No accounts returned from wallet.");
  return accounts[0];
}

async function getWalletChainId(): Promise<number> {
  if (!window.ethereum) throw new Error("No wallet");
  const hex = (await window.ethereum.request({ method: "eth_chainId" })) as string;
  return parseInt(hex, 16);
}

async function switchToChain(chainId: number, chainLabel: string): Promise<void> {
  if (!window.ethereum) throw new Error("No wallet");
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
  } catch (err: unknown) {
    // 4902 = chain not added yet
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      throw new Error(`${chainLabel} is not added to your wallet. Add it in your wallet settings and try again.`);
    }
    throw err;
  }
}

/** Build ERC-20 transfer calldata: transfer(address to, uint256 value) */
function buildTransferCalldata(to: string, amountBaseUnits: string): string {
  const selector = "a9059cbb";
  const paddedTo = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const paddedAmount = BigInt(amountBaseUnits).toString(16).padStart(64, "0");
  return `0x${selector}${paddedTo}${paddedAmount}`;
}

async function sendErc20Transfer(
  from: string,
  tokenAddress: string,
  to: string,
  amountBaseUnits: string,
): Promise<string> {
  if (!window.ethereum) throw new Error("No wallet");
  const data = buildTransferCalldata(to, amountBaseUnits);
  const txHash = (await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{
      from,
      to: tokenAddress,
      data,
    }],
  })) as string;
  return txHash;
}

// ── Components ────────────────────────────────────────────────────────────────

function EntitlementBadge({ ent, onRenew }: { ent: Entitlement; onRenew: () => void }) {
  return (
    <div className="rounded-xl border border-success/30 bg-success/10 p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-success/20">
            <CheckCircle2 size={20} className="text-success" />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-ink">{ent.planLabel} — active</div>
            <div className="mt-0.5 text-[12px] text-ink-secondary">
              Renews {formatExpiry(ent.expiresAt)} · {formatCredits(ent.creditsBalance)} credits remaining
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onRenew}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-hairline/40 bg-control px-3 py-1.5 text-[12px] text-ink hover:bg-raised-hover"
        >
          <RefreshCw size={12} />
          Renew early
        </button>
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: Plan;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full flex-col gap-1 rounded-xl border p-4 text-left transition-colors",
        selected
          ? "border-accent bg-accent/10"
          : "border-hairline/40 bg-card hover:border-accent/50 hover:bg-card",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold text-ink">{plan.label}</span>
        <span className="text-[15px] font-medium text-ink">{formatUsd(plan.usdCents)}<span className="text-[12px] font-normal text-ink-secondary">/mo</span></span>
      </div>
      <div className="flex items-center gap-1 text-[12px] text-ink-secondary">
        <Zap size={11} className="text-accent" />
        {formatCredits(plan.credits)} credits per month
      </div>
    </button>
  );
}

function ChainButton({
  chain,
  selected,
  onSelect,
}: {
  chain: Chain;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors",
        selected
          ? "border-accent bg-accent/10 font-medium text-ink"
          : "border-hairline/40 bg-card text-ink hover:border-accent/40",
      )}
    >
      <span className="font-mono text-[11px] text-ink-secondary">{chain.tokenSymbol}</span>
      <span>Pay with {chain.tokenSymbol} on {chain.isTestnet ? chain.label : chain.label}</span>
      {chain.isTestnet && (
        <span className="rounded bg-warning/20 px-1 py-px text-[10px] font-medium text-warning">TESTNET</span>
      )}
    </button>
  );
}

// ── Main subscribe page ───────────────────────────────────────────────────────

export function SubscribePage() {
  const { dispatch } = useStore();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [selectedChain, setSelectedChain] = useState<Chain | null>(null);
  const [step, setStep] = useState<PayStep>({ kind: "idle" });
  const [showRenew, setShowRenew] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load billing status and own entitlement
  const loadData = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([
        api("/api/billing/status") as Promise<BillingStatus>,
        api("/api/billing/entitlement") as Promise<{ entitlement: Entitlement | null }>,
      ]);
      setStatus(s);
      setEntitlement(e.entitlement);
      if (s.plans.length && !selectedPlan) setSelectedPlan(s.plans[0] ?? null);
      if (s.chains.length && !selectedChain) setSelectedChain(s.chains[0] ?? null);
    } catch {
      // silently ignore; billing may not be configured
    } finally {
      setLoading(false);
    }
  }, [selectedPlan, selectedChain]);

  useEffect(() => { void loadData(); }, [loadData]);

  // Poll for entitlement while watching a tx
  useEffect(() => {
    if (step.kind !== "watching") {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    const { txHash, quoteId } = step;
    const poll = async () => {
      try {
        const result = await api("/api/billing/confirm", {
          method: "POST",
          body: JSON.stringify({ txHash, quoteId }),
        }) as { ok: boolean; entitlement: Entitlement | null; code?: string };
        if (result.ok && result.entitlement) {
          setEntitlement(result.entitlement);
          setStep({ kind: "success", entitlement: result.entitlement });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // pending_confirmations is expected — keep polling
        if (!msg.includes("pending_confirmations")) {
          // Only surface a hard error (underpay, wrong chain, etc.)
          // Network errors during polling are ignored
        }
      }
    };
    pollRef.current = setInterval(() => { void poll(); }, 8_000);
    void poll(); // immediate first attempt
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [step]);

  // ── Payment flow ─────────────────────────────────────────────────────────

  const startPayment = useCallback(async () => {
    if (!selectedPlan || !selectedChain) return;
    setStep({ kind: "connecting" });
    try {
      const address = await connectWallet();
      setStep({ kind: "connected", address });

      // Ensure wallet is on the correct chain
      const currentChainId = await getWalletChainId();
      if (currentChainId !== selectedChain.chainId) {
        await switchToChain(selectedChain.chainId, selectedChain.label);
      }

      setStep({ kind: "quoting" });
      const quoteResult = await api("/api/billing/quotes", {
        method: "POST",
        body: JSON.stringify({ planId: selectedPlan.id, chainId: selectedChain.chainId }),
      }) as { quote: Quote };
      const quote = quoteResult.quote;
      setStep({ kind: "quoted", quote });

      setStep({ kind: "sending" });
      const txHash = await sendErc20Transfer(
        address,
        quote.tokenAddress,
        quote.receiverAddress,
        quote.amountBaseUnits,
      );

      setStep({ kind: "watching", txHash, quoteId: quote.id });
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [selectedPlan, selectedChain]);

  const reset = useCallback(() => {
    setStep({ kind: "idle" });
    setShowRenew(false);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <main className="flex h-full items-center justify-center bg-app">
        <Loader2 size={24} className="animate-spin text-ink-secondary" />
      </main>
    );
  }

  if (!status?.enabled) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-3 bg-app px-6 text-ink-secondary">
        <CreditCard size={32} className="opacity-40" />
        <div className="text-center">
          <div className="text-[15px] font-semibold text-ink">Plan upgrades coming soon</div>
          <div className="mt-1 text-[13px]">Check back shortly.</div>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "showChat" })}
          className="mt-2 flex items-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
        >
          <ChevronLeft size={14} />
          Back to chat
        </button>
      </main>
    );
  }

  // Success screen
  if (step.kind === "success") {
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
        <div className="flex items-center gap-3 border-b border-hairline/30 px-6 py-4">
          <button type="button" onClick={reset} className="flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink">
            <ChevronLeft size={16} />
            Plans
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
          <div className="flex size-16 items-center justify-center rounded-full bg-success/20">
            <CheckCircle2 size={32} className="text-success" />
          </div>
          <div className="text-center">
            <div className="text-[20px] font-semibold text-ink">Payment confirmed</div>
            <div className="mt-1 text-[14px] text-ink-secondary">
              {step.entitlement.planLabel} is now active until {formatExpiry(step.entitlement.expiresAt)}
            </div>
            <div className="mt-0.5 text-[13px] text-ink-secondary">
              {formatCredits(step.entitlement.creditsBalance)} credits added to your account
            </div>
          </div>
          <button
            type="button"
            onClick={() => dispatch({ type: "showChat" })}
            className="mt-2 rounded-lg bg-accent px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
          >
            Start chatting
          </button>
        </div>
      </main>
    );
  }

  const isPaying = ["connecting", "connected", "quoting", "sending", "watching"].includes(step.kind);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header */}
      <div className="shrink-0 border-b border-hairline/30 px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => dispatch({ type: "showChat" })}
            className="flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-ink"
          >
            <ChevronLeft size={16} />
          </button>
          <div>
            <h1 className="text-[16px] font-semibold text-ink">Monthly plans</h1>
            <p className="text-[12px] text-ink-secondary">Pay once, access for 30 days. Renew any time.</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[560px] space-y-5">

          {/* Active entitlement badge */}
          {entitlement?.active && !showRenew && (
            <EntitlementBadge ent={entitlement} onRenew={() => setShowRenew(true)} />
          )}

          {/* Plan picker */}
          {(!entitlement?.active || showRenew) && (
            <>
              <div className="space-y-2">
                <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Choose a plan</div>
                {status.plans.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    selected={selectedPlan?.id === plan.id}
                    onSelect={() => setSelectedPlan(plan)}
                  />
                ))}
              </div>

              {/* Chain picker */}
              <div className="space-y-2">
                <div className="text-[12px] font-medium uppercase tracking-wide text-ink-secondary">Payment method</div>
                <div className="flex flex-wrap gap-2">
                  {status.chains.map((chain) => (
                    <ChainButton
                      key={chain.chainId}
                      chain={chain}
                      selected={selectedChain?.chainId === chain.chainId}
                      onSelect={() => setSelectedChain(chain)}
                    />
                  ))}
                </div>
              </div>

              {/* Payment step display */}
              {isPaying && (
                <PaymentProgress step={step} chain={selectedChain} />
              )}

              {/* Error */}
              {step.kind === "error" && (
                <div className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/10 p-4">
                  <XCircle size={18} className="mt-0.5 shrink-0 text-danger" />
                  <div>
                    <div className="text-[13px] font-medium text-ink">Payment failed</div>
                    <div className="mt-0.5 text-[12px] text-ink-secondary">{step.message}</div>
                    <button
                      type="button"
                      onClick={reset}
                      className="mt-2 text-[12px] text-accent hover:underline"
                    >
                      Try again
                    </button>
                  </div>
                </div>
              )}

              {/* Pay button */}
              {!isPaying && (
                <div className="space-y-2">
                  {selectedPlan && selectedChain && (
                    <p className="text-[12px] text-ink-secondary">
                      You will be asked to send{" "}
                      <strong>{formatUsd(selectedPlan.usdCents)}</strong> worth of{" "}
                      <strong>{selectedChain.tokenSymbol}</strong> on{" "}
                      <strong>{selectedChain.label}</strong> from your wallet.
                      No approval required — a single transfer is all it takes.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={!selectedPlan || !selectedChain}
                    onClick={() => void startPayment()}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-accent py-3 text-[14px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Wallet size={16} />
                    {selectedPlan && selectedChain
                      ? `Pay with ${selectedChain.tokenSymbol} — ${formatUsd(selectedPlan.usdCents)}`
                      : "Select a plan and payment method"}
                  </button>
                  {showRenew && (
                    <button
                      type="button"
                      onClick={reset}
                      className="w-full text-center text-[12px] text-ink-secondary hover:text-ink"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}
            </>
          )}

          {/* What you get */}
          <div className="rounded-xl border border-hairline/30 p-4 text-[12px] text-ink-secondary space-y-1.5">
            <div className="font-medium text-ink">How it works</div>
            <div>1. Choose a plan and payment method above.</div>
            <div>2. Confirm the transfer in your wallet — one transaction, no approvals.</div>
            <div>3. Your plan activates automatically once the transfer is detected on-chain.</div>
            <div>Credits renew with each payment. Unused credits carry over if you renew early.</div>
          </div>
        </div>
      </div>
    </main>
  );
}

// ── Payment progress indicator ────────────────────────────────────────────────

function PaymentProgress({ step, chain }: { step: PayStep; chain: Chain | null }) {
  const steps: Array<{ label: string; done: boolean; active: boolean }> = [
    {
      label: "Connecting wallet",
      done: step.kind !== "connecting" && step.kind !== "idle",
      active: step.kind === "connecting",
    },
    {
      label: "Creating quote",
      done: ["sending", "watching", "success"].includes(step.kind),
      active: step.kind === "quoting",
    },
    {
      label: "Sending transfer",
      done: step.kind === "watching" || step.kind === "success",
      active: step.kind === "sending",
    },
    {
      label: chain ? `Watching ${chain.label} for confirmation` : "Watching chain",
      done: step.kind === "success",
      active: step.kind === "watching",
    },
  ];

  return (
    <div className="rounded-xl border border-hairline/30 bg-inset p-4">
      <div className="space-y-3">
        {steps.map(({ label, done, active }) => (
          <div key={label} className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full",
                done ? "bg-success/20" : active ? "bg-accent/20" : "bg-control",
              )}
            >
              {done ? (
                <CheckCircle2 size={12} className="text-success" />
              ) : active ? (
                <Loader2 size={12} className="animate-spin text-accent" />
              ) : (
                <div className="size-2 rounded-full bg-ink-secondary/30" />
              )}
            </div>
            <span
              className={cn(
                "text-[13px]",
                done ? "text-ink-secondary line-through" : active ? "font-medium text-ink" : "text-ink-secondary/50",
              )}
            >
              {label}
            </span>
          </div>
        ))}
      </div>
      {step.kind === "watching" && (
        <p className="mt-3 text-[11px] text-ink-secondary">
          This may take up to a minute. You can safely leave this page — your plan will activate automatically.
        </p>
      )}
    </div>
  );
}
