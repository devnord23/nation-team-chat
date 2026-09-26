import { createPublicClient, decodeEventLog, http, parseAbiItem, type Hex } from "viem";
import { CreditLedger, creditChains, creditError, type CreditChain, type CreditInvoice } from "./nation-credits.ts";
import { redactSecretsInText } from "./redact.ts";

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

/** Blocks one eth_getLogs call covers: well inside public RPC range limits. */
export const SCAN_CHUNK_BLOCKS = 500n;
/** Chunks one token may scan per pass while catching up (10,000 blocks), each saved as it lands. */
export const SCAN_CHUNKS_PER_PASS = 20;
/** How long after its expiry an unpaid request still draws the scan back to its own block. */
export const LATE_PAYMENT_WINDOW_MS = 24 * 60 * 60_000;

export interface ScanFailure { chain: number; name: string; symbol: string; token: string; error: string }
export interface ScanOptions {
  /** Defaults to console.error. One line per failed token, per skipped transfer. */
  log?: (line: string) => void;
  now?: number;
  /** Tests substitute the chain client. */
  client?: (chain: CreditChain) => ReturnType<typeof chainClient>;
}

/** An RPC error in its own words, without the endpoint: viem quotes the RPC URL (which may carry
 * a provider key) and the request body in its messages, so only the first line is kept, with
 * any URL and anything secret-shaped removed. */
export function scanErrorText(error: unknown): string {
  const field = (name: string) => error && typeof error === "object" && name in error && typeof (error as Record<string, unknown>)[name] === "string"
    ? String((error as Record<string, unknown>)[name]).trim() : "";
  // viem's short message names the failure class; its details carry the RPC's own reason.
  const short = field("shortMessage"), details = field("details").split(/\r?\n/)[0] ?? "";
  const raw = short ? (details && !short.includes(details) ? `${short} (${details})` : short) : (error instanceof Error ? error.message : String(error));
  const line = raw.split(/\r?\n/).map(part => part.trim()).find(Boolean) ?? "unknown error";
  return redactSecretsInText(line.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<rpc>")).slice(0, 300);
}

/** One pass of the payment scan. Each chain + token pair keeps its own cursor and matches only its
 * own invoices: USDG and $NATION share Robinhood Chain's id, and a cursor per chain id let the first
 * token's pass move past blocks the second had never scanned.
 *
 * Isolation: a token whose RPC calls fail is logged with its chain and token and retried on the
 * next pass; the other tokens are scanned regardless. The failures are returned, never thrown.
 *
 * Cursor lag: the cursor only moves while a token has unpaid requests, so after a quiet spell it
 * can sit far behind the chain head. A pass therefore starts at the later of the cursor and the
 * earliest block of any request that is still fresh (unexpired, or expired within
 * LATE_PAYMENT_WINDOW_MS): no transfer before a request's own block can pay it. From there it scans
 * up to SCAN_CHUNKS_PER_PASS chunks, saving the cursor after each, so a long gap closes over a few
 * passes instead of one 500-block chunk per 30 s. Requests that went stale without payment never
 * pull the scan back into history and never hold up fresh ones; a transfer for one that landed
 * while the scanner was stopped is checked and credited by the owner by hand
 * (docs/nation-jobs/credits-and-smoke.md, "Payment scanner"). */
export async function scanCreditPayments(ledger: CreditLedger, chains: CreditChain[] = creditChains(), options: ScanOptions = {}): Promise<ScanFailure[]> {
  const log = options.log ?? ((line: string) => console.error(line));
  const failures: ScanFailure[] = [];
  for (const chain of chains) {
    try {
      await scanToken(ledger, chain, options.now ?? Date.now(), log, options.client ?? chainClient);
    } catch (error) {
      const failure = { chain: chain.id, name: chain.name, symbol: chain.symbol, token: chain.token.toLowerCase(), error: scanErrorText(error) };
      failures.push(failure);
      log(`NATION payment scan failed for ${failure.symbol} on ${failure.name} (chain ${failure.chain}, token ${failure.token}): ${failure.error}. Its requests are kept and retried on the next pass; other tokens are unaffected.`);
    }
  }
  return failures;
}

async function scanToken(ledger: CreditLedger, chain: CreditChain, now: number, log: (line: string) => void, client: NonNullable<ScanOptions["client"]>): Promise<void> {
  const token = chain.token.toLowerCase();
  const invoices = ledger.db.prepare("SELECT * FROM credit_invoices WHERE chain=? AND lower(token)=? AND paid_tx IS NULL ORDER BY created_at").all(chain.id, token) as unknown as CreditInvoice[];
  const fresh = invoices.filter(invoice => invoice.expires_at > now - LATE_PAYMENT_WINDOW_MS);
  if (!fresh.length) return;
  const rpc = client(chain);
  const reported = await rpc.getChainId();
  if (reported !== chain.id) throw new Error(`payment RPC reports chain id ${reported}, expected ${chain.id}; refusing to scan the wrong network`);
  const head = await rpc.getBlockNumber();
  const end = head - BigInt(ledger.settings.confirmations) + 1n;
  const cursor = ledger.db.prepare("SELECT block FROM credit_scan_cursors WHERE chain=? AND token=?").get(chain.id, token);
  const floor = fresh.reduce((min, invoice) => BigInt(invoice.from_block) < min ? BigInt(invoice.from_block) : min, BigInt(fresh[0]!.from_block));
  const resume = cursor ? BigInt(String(cursor.block)) + 1n : floor;
  let start = resume > floor ? resume : floor;
  // Any unpaid request can still match a transfer in the blocks scanned, stale ones included.
  const open = [...invoices];
  // A transfer of exactly a credited request's amount is almost certainly the same buyer paying
  // twice. Nothing credits it automatically, so it is logged for the owner to refund or credit.
  const paidMatch = ledger.db.prepare("SELECT id, paid_tx FROM credit_invoices WHERE chain=? AND lower(token)=? AND treasury=? AND paid_tx IS NOT NULL AND (token_amount=? OR (token_amount='' AND amount_micros=?)) LIMIT 1");
  for (let chunk = 0; chunk < SCAN_CHUNKS_PER_PASS && start <= end; chunk++) {
    const to = start + SCAN_CHUNK_BLOCKS - 1n < end ? start + SCAN_CHUNK_BLOCKS - 1n : end;
    // A treasury may have changed since an invoice was created. Query each retained destination.
    for (const treasury of new Set(open.map(invoice => invoice.treasury))) {
      const logs = await rpc.getLogs({ address: chain.token as Hex, event: transferEvent, args: { to: treasury as Hex }, fromBlock: start, toBlock: to, strict: true });
      for (const transfer of logs) {
        if (!transfer.transactionHash) continue;
        const hash = transfer.transactionHash.toLowerCase();
        const index = open.findIndex(invoice => invoice.treasury === treasury && BigInt(invoice.token_amount || invoice.amount_micros) === transfer.args.value);
        if (index < 0) {
          const value = transfer.args.value.toString();
          const paid = paidMatch.get(chain.id, token, treasury, value, Number.isSafeInteger(Number(value)) ? Number(value) : -1);
          if (paid && String(paid.paid_tx) !== hash) {
            log(`NATION payment scan found a second transfer ${hash} (${chain.symbol}, chain ${chain.id}) for request ${String(paid.id)}, already credited by ${String(paid.paid_tx)}. Nothing credits it automatically: refund it or credit it by hand.`);
          }
          continue;
        }
        const invoice = open[index]!;
        try {
          await confirmCreditPayment(ledger, invoice, hash, rpc);
          open.splice(index, 1);
        } catch (error) {
          // Credited meanwhile from this very transaction's pasted hash: nothing to report.
          const current = ledger.invoice(invoice.id);
          if (current?.paid_tx === hash) { open.splice(index, 1); continue; }
          // A transfer that can never pay this request (it predates it, or the request or the
          // transaction was credited otherwise) is set aside so it cannot pin the cursor.
          // Anything else, such as a receipt not yet visible, retries this range next pass.
          const used = Boolean(ledger.db.prepare("SELECT 1 FROM credit_ledger WHERE tx_hash=?").get(hash));
          if ((error as { status?: unknown }).status !== 400 && !current?.paid_tx && !used) throw error;
          if (current?.paid_tx) open.splice(index, 1);
          log(`NATION payment scan set aside transfer ${hash} (${chain.symbol}, chain ${chain.id}) for request ${invoice.id}: ${scanErrorText(error)}. Review it by hand if it was a real payment.`);
        }
      }
    }
    ledger.db.prepare("INSERT INTO credit_scan_cursors VALUES(?,?,?) ON CONFLICT(chain, token) DO UPDATE SET block=excluded.block").run(chain.id, token, String(to));
    start = to + 1n;
  }
}

/** Persisted scan cursors + retained invoices also recover matching late transfers after a restart. */
/** Seconds between payment scans: NATION_CREDIT_SCAN_SECONDS, 5 to 300, default 30. */
export function creditScanIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number(env.NATION_CREDIT_SCAN_SECONDS);
  return (Number.isInteger(seconds) && seconds >= 5 && seconds <= 300 ? seconds : 30) * 1000;
}

export function startCreditWatcher(ledger: CreditLedger): () => void {
  let running = false, stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    // Per-token failures are logged by the scan itself; this catches the rest (the database).
    try { await scanCreditPayments(ledger); }
    catch (error) { console.error(`NATION payment scan stopped: ${scanErrorText(error)}. Retained invoices will be retried.`); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, creditScanIntervalMs()); timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
