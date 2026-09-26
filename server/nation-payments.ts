import { createPublicClient, decodeEventLog, http, parseAbiItem, type Hex } from "viem";
import { CreditLedger, creditChains, creditError, type CreditChain, type CreditInvoice } from "./nation-credits.ts";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export interface PaymentRpc {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; transactionHash: Hex; blockNumber: bigint; blockHash: Hex; logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[] }>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hex | null; timestamp: bigint }>;
}
export function chainClient(chain: CreditChain) { return createPublicClient({ transport: http(chain.rpc, { timeout: 15_000, retryCount: 1 }) }); }

/** Receipt/log verification is entirely server-side. Unique invoice amounts are never recycled. */
export async function verifyCreditPayment(invoice: CreditInvoice, hash: string, rpc: PaymentRpc, confirmations: number): Promise<number> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw creditError("Enter a valid transaction hash.");
  if (await rpc.getChainId() !== invoice.chain) throw creditError("Payment network could not be verified.", 502);
  const receipt = await rpc.getTransactionReceipt({ hash: hash as Hex });
  if (receipt.status !== "success" || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw creditError("The transfer was not successful.");
  const head = await rpc.getBlockNumber();
  if (head < receipt.blockNumber || head - receipt.blockNumber + 1n < BigInt(confirmations)) throw creditError("Payment is still confirming. Please check again shortly.", 409);
  const block = await rpc.getBlock({ blockNumber: receipt.blockNumber });
  if (!block.hash || block.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw creditError("Payment is still confirming. Please check again shortly.", 409);
  if (Number(block.timestamp) * 1000 < invoice.created_at - 60_000) throw creditError("This transfer predates the payment request.");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== invoice.token.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
      if (decoded.args.to.toLowerCase() !== invoice.treasury.toLowerCase()) continue;
      // token_amount is the expected ERC-20 transfer value; for 6-decimal tokens it equals amount_micros.
      const expectedTokenAmount = BigInt(invoice.token_amount || invoice.amount_micros);
      if (decoded.args.value === expectedTokenAmount && decoded.args.value >= BigInt(invoice.token_amount ? invoice.pack_micros : invoice.amount_micros)) return invoice.amount_micros;
    } catch { /* another event from the same contract is not a payment */ }
  }
  throw creditError("The transfer token, destination or exact amount does not match this payment request.");
}
export async function confirmCreditPayment(ledger: CreditLedger, invoice: CreditInvoice, hash: string, rpc?: PaymentRpc): Promise<void> {
  if (invoice.paid_tx) throw creditError("This payment request has already been credited.", 409);
  const chain = creditChains().find(chain => chain.id === invoice.chain);
  if (!rpc && !chain) throw creditError("Payment verification is temporarily unavailable. Your payment request is preserved.", 503);
  const amount = await verifyCreditPayment(invoice, hash, rpc ?? chainClient(chain!), ledger.settings.confirmations);
  ledger.paid(invoice, hash, amount);
}

/** One pass of the payment scan. Each chain + token pair keeps its own cursor and matches only its
 * own invoices: USDG and $NATION share Robinhood Chain's id, and a cursor per chain id let the first
 * token's pass move past blocks the second had never scanned. Throws so the caller retries later. */
export async function scanCreditPayments(ledger: CreditLedger, chains: CreditChain[] = creditChains()): Promise<void> {
  for (const chain of chains) {
    const invoices = ledger.db.prepare("SELECT * FROM credit_invoices WHERE chain=? AND lower(token)=? AND paid_tx IS NULL ORDER BY created_at").all(chain.id, chain.token.toLowerCase()) as unknown as CreditInvoice[];
    if (!invoices.length) continue;
    const rpc = chainClient(chain);
    if (await rpc.getChainId() !== chain.id) throw new Error("Payment RPC network mismatch");
    const head = await rpc.getBlockNumber();
    const end = head - BigInt(ledger.settings.confirmations) + 1n;
    const cursor = ledger.db.prepare("SELECT block FROM credit_scan_cursors WHERE chain=? AND token=?").get(chain.id, chain.token.toLowerCase());
    const earliest = invoices.reduce((min, invoice) => BigInt(invoice.from_block) < min ? BigInt(invoice.from_block) : min, BigInt(invoices[0]!.from_block));
    const start = cursor ? BigInt(String(cursor.block)) + 1n : earliest;
    if (end < start) continue;
    const to = start + 499n < end ? start + 499n : end;
    // A treasury may have changed since an invoice was created. Query each retained destination.
    for (const treasury of new Set(invoices.map(invoice => invoice.treasury))) {
      const logs = await rpc.getLogs({ address: chain.token as Hex, event: transferEvent, args: { to: treasury as Hex }, fromBlock: start, toBlock: to, strict: true });
      for (const log of logs) {
        const invoice = invoices.find(invoice => invoice.treasury === treasury && BigInt(invoice.token_amount || invoice.amount_micros) === log.args.value);
        if (!invoice || !log.transactionHash) continue;
        await confirmCreditPayment(ledger, invoice, log.transactionHash, rpc);
      }
    }
    ledger.db.prepare("INSERT INTO credit_scan_cursors VALUES(?,?,?) ON CONFLICT(chain, token) DO UPDATE SET block=excluded.block").run(chain.id, chain.token.toLowerCase(), String(to));
  }
}

/** Persisted scan cursors + retained invoices also recover matching late transfers after a restart. */
export function startCreditWatcher(ledger: CreditLedger): () => void {
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await scanCreditPayments(ledger); }
    catch { console.error("NATION payment scan paused; retained invoices will be retried."); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, 30_000); timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
