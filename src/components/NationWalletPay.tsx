import { useCallback, useEffect, useState } from "react";
import { api } from "@/state/store";
import { approveWithPasskey, createWalletPasskey, passkeysSupported } from "@/lib/nation-wallet";

export interface EmbeddedWallet {
  address: string;
  credentialId: string;
  balances?: { tokens: Array<{ symbol: string; token: string; amount: string }>; eth: string } | null;
}

export interface EmbeddedWalletStatus {
  available: boolean;
  wallet: EmbeddedWallet | null;
}

/** "12.5", "0.0021": a balance to at most four decimals, never in exponent form. */
export function shortAmount(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const trimmed = fraction.slice(0, 4).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
}

/** What the NATION wallet block shows; pure, so every state is testable. */
export function NationWalletPanel({
  status,
  symbol,
  token,
  amount,
  disabled,
  busy,
  error,
  copied,
  onCreate,
  onPay,
  onRefresh,
  onCopy,
}: {
  status: EmbeddedWalletStatus | null;
  symbol: string;
  token: string;
  amount: string;
  disabled: boolean;
  busy: "create" | "pay" | "refresh" | null;
  error: string;
  copied: boolean;
  onCreate: () => void;
  onPay: () => void;
  onRefresh: () => void;
  onCopy: () => void;
}) {
  if (!status?.available) return null;
  const wallet = status.wallet;
  const held = wallet?.balances?.tokens.find((item) => item.token.toLowerCase() === token.toLowerCase());
  const primary = "mt-3 w-full rounded-xl bg-nation py-3 font-semibold text-nation-ink transition-opacity disabled:opacity-50";
  return (
    <div className="mt-5 rounded-xl border border-hairline p-4" data-testid="nation-wallet">
      <p className="text-[14px] font-semibold text-ink">Pay from your NATION wallet</p>
      {!wallet ? (
        <>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">
            A wallet on Robinhood Chain that only a passkey on this device can use. No browser extension, and Nation Team Chat can never move its funds.
          </p>
          <button type="button" className={primary} disabled={Boolean(busy)} onClick={onCreate}>
            {busy === "create" ? "Creating your wallet…" : "Create NATION wallet"}
          </button>
        </>
      ) : (
        <>
          <div className="mt-2 flex items-center justify-between gap-3">
            <code className="min-w-0 break-all font-mono text-[12.5px] text-ink">{wallet.address}</code>
            <button
              type="button"
              className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-ink-secondary hover:bg-raised hover:text-ink"
              onClick={onCopy}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
          </div>
          <p className="mt-1 text-[12.5px] text-ink-secondary">
            {wallet.balances
              ? `Holds ${shortAmount(held?.amount ?? "0")} ${symbol} and ${shortAmount(wallet.balances.eth)} ETH for network fees.`
              : "Balance unavailable right now."}{" "}
            <button type="button" className="underline hover:text-ink" disabled={Boolean(busy)} onClick={onRefresh}>
              {busy === "refresh" ? "Checking…" : "Refresh"}
            </button>
          </p>
          <button type="button" className={primary} disabled={disabled || Boolean(busy)} onClick={onPay}>
            {busy === "pay" ? "Approve with your passkey…" : `Pay ${amount} ${symbol} from NATION wallet`}
          </button>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-secondary">
            To fund it, send {symbol} and a little ETH for the network fee to this address on Robinhood Chain.
          </p>
        </>
      )}
      {error ? <p className="mt-3 text-[13px] text-danger" role="alert">{error}</p> : null}
    </div>
  );
}

/** Pay an open payment request from the account's own NATION wallet, held by
 * a passkey on this device. Renders nothing where the wallet is not offered
 * or the browser has no passkeys; the connected-wallet and paste-a-hash
 * paths stay. */
export function NationWalletPay({
  invoiceId,
  symbol,
  token,
  amount,
  disabled,
  onSent,
}: {
  invoiceId: string;
  symbol: string;
  token: string;
  amount: string;
  disabled: boolean;
  onSent: (txHash: string) => void;
}) {
  const [status, setStatus] = useState<EmbeddedWalletStatus | null>(null);
  const [busy, setBusy] = useState<"create" | "pay" | "refresh" | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setStatus((await api("/api/credits/wallet/embedded")) as EmbeddedWalletStatus);
  }, []);
  useEffect(() => {
    void load().catch(() => setStatus({ available: false, wallet: null }));
  }, [load]);

  if (!passkeysSupported()) return null;

  const act = async (kind: "create" | "pay" | "refresh", work: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError("");
    try {
      await work();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A dismissed passkey prompt is not an error worth a paragraph.
      setError(/NotAllowedError|timed out|not allowed/i.test(message) ? "The passkey prompt was closed. Try again when you are ready." : message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <NationWalletPanel
      status={status}
      symbol={symbol}
      token={token}
      amount={amount}
      disabled={disabled}
      busy={busy}
      error={error}
      copied={copied}
      onCreate={() => void act("create", async () => {
        const passkey = await createWalletPasskey();
        await api("/api/credits/wallet/embedded", { method: "POST", body: JSON.stringify(passkey) });
        await load();
      })}
      onPay={() => void act("pay", async () => {
        const prepared = await api("/api/credits/wallet/embedded/prepare", { method: "POST", body: JSON.stringify({ invoiceId }) });
        const stamp = await approveWithPasskey(prepared.body, prepared.credentialId);
        const sent = await api("/api/credits/wallet/embedded/pay", { method: "POST", body: JSON.stringify({ invoiceId, body: prepared.body, stamp }) });
        onSent(sent.txHash);
        await load().catch(() => undefined);
      })}
      onRefresh={() => void act("refresh", load)}
      onCopy={() => {
        const address = status?.wallet?.address;
        if (!address) return;
        void navigator.clipboard?.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}
