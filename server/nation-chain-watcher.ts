/**
 * Nation chain watcher: polls ERC-20 Transfer logs to the treasury address
 * and confirms payments. Uses viem's public client for log fetching.
 *
 * Design:
 *   - Background poller runs every POLL_INTERVAL_MS (30 s by default).
 *   - On each tick, fetches Transfer(from, to=treasury, amount) logs from the
 *     last processed block to latest - CONFIRMATIONS. This makes it reorg-safe:
 *     we never credit a block that might still be reorganized out.
 *   - Each Transfer log is matched against pending quotes by (chainId, amount, to).
 *   - If matched, confirmPayment() is called — idempotent (paymentExists check
 *     prevents double-crediting even if the log is seen twice).
 *   - Cursor (last processed block) is persisted per chain to disk so a server
 *     restart does not re-scan from genesis.
 *   - Tx-hash confirmation path: client submits txHash → server fetches the
 *     receipt, checks the Transfer log in it, then calls confirmPayment().
 *     This is the fast path (< 1 block confirmation lag); the poller is the
 *     safety net for missed submissions.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, parseAbiItem } from "viem";
import { writeFileAtomic } from "./atomic.ts";
import { confirmPayment, matchTransferToQuote } from "./nation-billing.ts";
import {
  type ChainConfig,
  availableChains,
  rpcUrlForChain,
  requiredConfirmations,
  treasuryAddress,
} from "./nation-plans.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WatcherHealth {
  running: boolean;
  chains: Array<{
    chainId: number;
    label: string;
    lastProcessedBlock: number | null;
    lastPollAt: string | null;
    lastError: string | null;
  }>;
}

export interface TxConfirmResult {
  ok: boolean;
  error?: string;
  code?: string;
  quoteId?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 30_000;
/** Max blocks to scan per poll tick (avoid huge getLogs windows). */
const MAX_BLOCKS_PER_POLL = 500;
/** ERC-20 Transfer(address indexed from, address indexed to, uint256 value) */
const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

// ── Cursor persistence ────────────────────────────────────────────────────────

function dataRoot(): string {
  return process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
}

function cursorDir(): string {
  const dir = join(dataRoot(), "nation-billing", "cursors");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function cursorPath(chainId: number): string {
  return join(cursorDir(), `chain-${chainId}.json`);
}

function readCursor(chainId: number): bigint | null {
  try {
    const p = cursorPath(chainId);
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf8")) as { block: string };
    return BigInt(data.block);
  } catch {
    return null;
  }
}

function writeCursor(chainId: number, block: bigint): void {
  try {
    writeFileAtomic(cursorPath(chainId), JSON.stringify({ block: block.toString() }));
  } catch (err) {
    console.error(`[nation-watcher] cursor write failed (chain ${chainId}): ${err}`);
  }
}

// ── Health state ──────────────────────────────────────────────────────────────

interface ChainState {
  chainId: number;
  label: string;
  lastProcessedBlock: bigint | null;
  lastPollAt: string | null;
  lastError: string | null;
}

const chainStates = new Map<number, ChainState>();
let watcherRunning = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function watcherHealth(): WatcherHealth {
  return {
    running: watcherRunning,
    chains: Array.from(chainStates.values()).map((s) => ({
      chainId: s.chainId,
      label: s.label,
      lastProcessedBlock: s.lastProcessedBlock !== null ? Number(s.lastProcessedBlock) : null,
      lastPollAt: s.lastPollAt,
      lastError: s.lastError,
    })),
  };
}

// ── Public client factory ─────────────────────────────────────────────────────

function makeClient(chain: ChainConfig, env: NodeJS.ProcessEnv) {
  const rpcUrl = rpcUrlForChain(chain, env);
  // viem chain definition (minimal — we only need id and rpcUrls)
  return createPublicClient({
    chain: {
      id: chain.chainId,
      name: chain.label,
      nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl, { retryCount: 3, retryDelay: 1000 }),
  });
}

// ── Per-chain poll tick ───────────────────────────────────────────────────────

async function pollChain(
  chain: ChainConfig,
  treasury: `0x${string}`,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  let state = chainStates.get(chain.chainId);
  if (!state) {
    state = { chainId: chain.chainId, label: chain.label, lastProcessedBlock: null, lastPollAt: null, lastError: null };
    chainStates.set(chain.chainId, state);
  }

  const client = makeClient(chain, env);
  const confirmations = BigInt(requiredConfirmations(env));

  try {
    const latest = await client.getBlockNumber();
    const safeHead = latest - confirmations;
    if (safeHead < 0n) return;

    const cursor = readCursor(chain.chainId) ?? state.lastProcessedBlock;
    const fromBlock = cursor !== null ? cursor + 1n : safeHead;
    const toBlock = fromBlock + BigInt(MAX_BLOCKS_PER_POLL) < safeHead
      ? fromBlock + BigInt(MAX_BLOCKS_PER_POLL)
      : safeHead;

    if (fromBlock > toBlock) {
      state.lastPollAt = new Date().toISOString();
      state.lastError = null;
      return;
    }

    const logs = await client.getLogs({
      address: chain.tokenAddress,
      event: TRANSFER_EVENT,
      args: { to: treasury },
      fromBlock,
      toBlock,
    });

    for (const log of logs as Array<{ args?: { value?: bigint; to?: string }; transactionHash?: string | null; blockNumber?: bigint | null }>) {
      await processTransferLog(log, chain, env);
    }

    writeCursor(chain.chainId, toBlock);
    state.lastProcessedBlock = toBlock;
    state.lastPollAt = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error(`[nation-watcher] poll error (chain ${chain.chainId}): ${state.lastError}`);
  }
}

async function processTransferLog(
  log: { args?: { value?: bigint; to?: string; from?: string }; transactionHash?: string | null; blockNumber?: bigint | null },
  chain: ChainConfig,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!log.args?.value || !log.transactionHash || log.blockNumber === null || log.blockNumber === undefined) return;
  const amountBaseUnits = log.args.value;
  const to = log.args.to ?? "";
  const txHash = log.transactionHash;
  const blockNumber = Number(log.blockNumber);

  const quote = matchTransferToQuote(chain.chainId, to, amountBaseUnits);
  if (!quote) return;

  const result = confirmPayment(
    { quoteId: quote.id, txHash, chainId: chain.chainId, actualAmountBaseUnits: amountBaseUnits, blockNumber },
    env,
  );
  if (result.ok) {
    console.log(
      `[nation-watcher] credited quote ${quote.id} user=${quote.userId} plan=${quote.planId} tx=${txHash}`,
    );
  } else if (result.code !== "already_credited") {
    console.warn(`[nation-watcher] confirmPayment failed for tx ${txHash}: ${result.error}`);
  }
}

// ── Watcher lifecycle ─────────────────────────────────────────────────────────

function schedulePoll(env: NodeJS.ProcessEnv): void {
  pollTimer = setTimeout(() => {
    void runPoll(env);
  }, POLL_INTERVAL_MS);
}

async function runPoll(env: NodeJS.ProcessEnv): Promise<void> {
  if (!watcherRunning) return;
  const chains = availableChains(env);
  await Promise.allSettled(
    chains.map(async (chain) => {
      const treasury = treasuryAddress(chain, env);
      if (!treasury) return;
      await pollChain(chain, treasury, env);
    }),
  );
  if (watcherRunning) schedulePoll(env);
}

export function startChainWatcher(env: NodeJS.ProcessEnv = process.env): void {
  if (watcherRunning) return;
  const chains = availableChains(env);
  if (!chains.length) {
    console.log("[nation-watcher] no treasury addresses configured — watcher not started");
    return;
  }
  watcherRunning = true;
  console.log(`[nation-watcher] starting — watching ${chains.map((c) => c.label).join(", ")}`);
  schedulePoll(env);
}

export function stopChainWatcher(): void {
  watcherRunning = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ── Fast path: confirm by submitted tx hash ───────────────────────────────────

export async function confirmByTxHash(
  txHash: string,
  quoteId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TxConfirmResult> {
  const { loadQuote } = await import("./nation-billing-store.ts");
  const quote = loadQuote(quoteId);
  if (!quote) return { ok: false, error: "quote not found", code: "quote_not_found" };
  if (quote.status !== "pending") return { ok: false, error: `quote is ${quote.status}`, code: "quote_not_pending" };

  const { chainById } = await import("./nation-plans.ts");

  const chain = chainById(quote.chainId, env);
  if (!chain) return { ok: false, error: "chain not found", code: "chain_missing" };
  const treasury = treasuryAddress(chain, env);
  if (!treasury) return { ok: false, error: "treasury not configured", code: "treasury_not_configured" };

  const client = makeClient(chain, env);
  const confirmations = BigInt(requiredConfirmations(env));

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return { ok: false, error: "tx not found or not yet mined", code: "tx_not_found" };
  }

  if (receipt.status === "reverted") {
    return { ok: false, error: "tx reverted", code: "tx_reverted" };
  }

  const latestBlock = await client.getBlockNumber();
  const txBlock = receipt.blockNumber;
  if (latestBlock - txBlock < confirmations) {
    return { ok: false, error: `waiting for confirmations (${latestBlock - txBlock}/${confirmations})`, code: "pending_confirmations" };
  }

  // Find the Transfer log in this tx to the treasury
  let transferValue: bigint | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== chain.tokenAddress.toLowerCase()) continue;
    // Transfer topic0 + to topic2
    if (
      log.topics[0]?.toLowerCase() !== chain.transferTopic.toLowerCase() ||
      log.topics.length < 3
    ) continue;
    const toInLog = "0x" + log.topics[2]!.slice(-40);
    if (toInLog.toLowerCase() !== treasury.toLowerCase()) continue;
    // Parse value from data (bytes32)
    transferValue = BigInt(log.data);
    break;
  }

  if (transferValue === null) {
    return { ok: false, error: "no Transfer to treasury found in tx", code: "no_transfer_found" };
  }

  const result = confirmPayment(
    {
      quoteId,
      txHash,
      chainId: quote.chainId,
      actualAmountBaseUnits: transferValue,
      blockNumber: Number(receipt.blockNumber),
    },
    env,
  );

  if (!result.ok) return { ok: false, error: result.error, code: result.code };
  return { ok: true, quoteId };
}
