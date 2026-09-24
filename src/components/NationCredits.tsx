import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { EIP1193Provider, Hex } from "viem";
import { api, useStore } from "@/state/store";

type Chain = { id: number; name: string; symbol: string; token: Hex; treasury: Hex };
type Invoice = { id: string; chain: number; treasury: Hex; token: Hex; amount_micros: number; expires_at: number; paid_tx: string | null };
type Status = { balanceUsd: number; label: string; verified: boolean; exempt: boolean; lowBalance: boolean; topUpEnabled: boolean; topUpMessage: string; starterMessage: string; packs: number[]; chains: Chain[]; invoices: Invoice[] };
const button = "rounded-xl bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-50";
const field = "w-full rounded-xl border border-hairline/50 bg-inset p-3 text-ink";
async function injectedWallet() {
  const { createWalletClient, custom } = await import("viem");
  const provider = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!provider) throw new Error("Open an injected wallet, or use the address and transaction hash below.");
  return createWalletClient({ transport: custom(provider) });
}

export function NationCredits() {
  const { state } = useStore();
  const [status, setStatus] = useState<Status | null>(null);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null), [hash, setHash] = useState("");
  const [pack, setPack] = useState(10), [chainId, setChainId] = useState(8453);
  const closeRef = useRef<HTMLButtonElement>(null);
  const refresh = useCallback(async () => {
    const value: Status = await api("/api/credits/status");
    setStatus(value);
    setPack(current => value.packs.includes(current) ? current : value.packs[0] ?? 10);
    setChainId(current => value.chains.some(chain => chain.id === current) ? current : value.chains[0]?.id ?? 8453);
    setInvoice(current => current ? value.invoices.find(item => item.id === current.id) ?? current : null);
  }, []);
  useEffect(() => {
    if (!state.connected) return;
    void refresh().catch(() => {});
    const timer = setInterval(() => { void refresh().catch(() => {}); }, open ? 5000 : 15000);
    return () => clearInterval(timer);
  }, [state.connected, open, refresh]);
  useEffect(() => { if (open) closeRef.current?.focus(); }, [open]);
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await work(); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Please try again."); }
    finally { setBusy(false); }
  };
  const verify = () => run(async () => {
    const wallet = await injectedWallet();
    const [address] = await wallet.requestAddresses();
    if (!address) throw new Error("Choose a wallet account.");
    const challenge = await api("/api/credits/wallet/challenge", { method: "POST", body: JSON.stringify({ address }) });
    const signature = await wallet.signMessage({ account: address, message: challenge.message });
    await api("/api/credits/wallet/verify", { method: "POST", body: JSON.stringify({ challengeId: challenge.challengeId, signature }) });
  });
  const createInvoice = () => run(async () => {
    setInvoice(await api("/api/credits/invoices", { method: "POST", body: JSON.stringify({ chain: chainId, packUsd: pack }) })); setHash("");
  });
  const pay = () => run(async () => {
    if (!invoice || invoice.expires_at <= Date.now()) throw new Error("Create a new payment request. A matching payment already sent can still be credited.");
    const wallet = await injectedWallet();
    const { defineChain, encodeFunctionData, parseAbi } = await import("viem");
    const transferAbi = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
    const chain = defineChain({ id: invoice.chain, name: invoice.chain === 8453 ? "Base" : "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [invoice.chain === 8453 ? "https://mainnet.base.org" : "https://rpc.mainnet.chain.robinhood.com"] } } });
    try { await wallet.switchChain({ id: chain.id }); }
    catch (error) {
      const code = (error as { code?: number; cause?: { code?: number } }).cause?.code ?? (error as { code?: number }).code;
      if (code !== 4902) throw error;
      await wallet.addChain({ chain }); await wallet.switchChain({ id: chain.id });
    }
    const [account] = await wallet.requestAddresses();
    if (!account) throw new Error("Choose a wallet account.");
    const tx = await wallet.sendTransaction({ account, chain, to: invoice.token,
      data: encodeFunctionData({ abi: transferAbi, functionName: "transfer", args: [invoice.treasury, BigInt(invoice.amount_micros)] }) });
    setHash(tx);
  });
  const confirm = () => run(async () => {
    if (!invoice) return;
    await api("/api/credits/confirm", { method: "POST", body: JSON.stringify({ invoiceId: invoice.id, txHash: hash.trim() }) });
  });
  if (!status) return null;
  const selectedChain = status.chains.find(chain => chain.id === (invoice?.chain ?? chainId));
  const paid = Boolean(invoice?.paid_tx);
  return <>
    <div className="flex flex-wrap items-center justify-end gap-3 border-b border-hairline/30 bg-panel px-4 py-2 text-xs text-ink">
      <span>{status.exempt ? "NATION API" : status.label}</span>
      {status.lowBalance && status.verified && <span>Your teammates are ready when you are. Add credit to keep going.</span>}
      {!status.verified && <button className="underline" onClick={() => setOpen(true)}>Get free starter credit</button>}
      {status.topUpEnabled && !status.exempt ? <button className="font-medium underline" onClick={() => setOpen(true)}>Top up</button> : !status.exempt && <span>{status.topUpMessage}</span>}
    </div>
    {open && <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="nation-credit-title" className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl bg-panel p-6 text-ink shadow-2xl" onKeyDown={event => {
        if (event.key === "Escape" && !busy) setOpen(false);
        if (event.key === "Tab") {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <div className="flex items-center justify-between gap-4"><h2 id="nation-credit-title" className="text-xl font-semibold">NATION credit</h2><button ref={closeRef} onClick={() => setOpen(false)} disabled={busy} aria-label="Close credit panel">Close</button></div>
        <p className="mt-2 text-lg">{status.label}</p>
        <p className="mt-2 text-sm text-ink-secondary">Your credit never expires. You pay only when you choose to top up. No automatic or recurring charges.</p>
        {!status.verified ? <div className="mt-5 space-y-3"><p>{status.starterMessage}</p><p className="text-sm text-ink-secondary">Sign in with your verified email, or verify a wallet with a free signature. No payment is needed to start.</p><button className={button} disabled={busy} onClick={() => void verify()}>Verify wallet for starter credit</button></div>
          : !status.topUpEnabled ? <p className="mt-5">Top up coming soon</p>
          : <div className="mt-5 space-y-4">
            <label className="block">Credit pack<select className={field} value={pack} onChange={event => setPack(Number(event.target.value))}>{status.packs.map(value => <option key={value} value={value}>${value} credit</option>)}</select></label>
            <label className="block">Payment network<select className={field} value={chainId} onChange={event => setChainId(Number(event.target.value))}>{status.chains.map(chain => <option key={chain.id} value={chain.id}>{chain.symbol} on {chain.name}</option>)}</select></label>
            <button className={button} disabled={busy} onClick={() => void createInvoice()}>Create payment request</button>
            {!invoice && status.invoices.some(item => !item.paid_tx) && <div className="space-y-2"><p className="text-sm">Recent payment requests</p>{status.invoices.filter(item => !item.paid_tx).map(item => <button key={item.id} className="block underline" onClick={() => { setInvoice(item); setHash(""); }}>Resume {(item.amount_micros / 1e6).toFixed(6)} payment</button>)}</div>}
            {invoice && <div className="space-y-3 rounded-2xl bg-inset p-4">
              {paid ? <p role="status">Payment verified. Your credit is ready.</p> : <>
                <p className="font-semibold">Send exactly {(invoice.amount_micros / 1e6).toFixed(6)} {selectedChain?.symbol ?? (invoice.chain === 8453 ? "USDC" : "USDG")}</p>
                <p className="text-sm">Network: {selectedChain?.name ?? (invoice.chain === 8453 ? "Base" : "Robinhood Chain")}. The unique amount matches this payment to you and is fully credited.</p>
                <code className="block break-all text-xs">{invoice.treasury}</code>
                <div className="w-fit rounded-xl bg-white p-3"><QRCodeSVG value={`ethereum:${invoice.token}@${invoice.chain}/transfer?address=${invoice.treasury}&uint256=${invoice.amount_micros}`} size={176} /></div>
                <p className="text-xs text-ink-secondary">Pay within 30 minutes. Matching late transfers are still credited. Your wallet may require a separate network fee in ETH.</p>
                <button className={button} disabled={busy || invoice.expires_at <= Date.now() || Boolean(hash)} onClick={() => void pay()}>Connect wallet and pay</button>
                <label className="block text-sm">Already paid? Transaction hash<input className={field} value={hash} onChange={event => setHash(event.target.value)} placeholder="0x…" spellCheck={false} /></label>
                <button className={button} disabled={busy || !/^0x[0-9a-f]{64}$/i.test(hash.trim())} onClick={() => void confirm()}>Check payment</button>
                {hash && <p className="text-xs">Waiting for network confirmations. You can check again without sending another payment.</p>}
              </>}
            </div>}
          </div>}
        {busy && <p role="status" className="mt-3 text-sm">Please wait…</p>}
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      </section>
    </div>}
  </>;
}

