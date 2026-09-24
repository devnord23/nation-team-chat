/**
 * Nation billing logic: quotes, payment confirmation, entitlement granting.
 *
 * Flow:
 *   1. POST /api/billing/quote   → create a quote with exact expected amount
 *   2. Client sends ERC-20 transfer on-chain
 *   3. POST /api/billing/confirm → verify tx, grant entitlement (or poller does it)
 *   4. GET  /api/billing/entitlement → check active access & credit balance
 *
 * Idempotency: a tx hash can only be credited once (paymentExists check).
 * Underpay: rejected with `underpay` error (tolerance: exact match required).
 * Overpay: accepted (credited as if correct amount). We log the surplus.
 * Expired quote: rejected with `quote_expired` error.
 */
import { randomBytes } from "node:crypto";
import {
  type Quote,
  type Payment,
  type Entitlement,
  findPendingQuoteByAmount,
  grantEntitlement,
  loadEntitlement,
  loadPayment,
  loadQuote,
  paymentExists,
  savePayment,
  saveQuote,
  updateQuote,
} from "./nation-billing-store.ts";
import {
  AMOUNT_SUFFIX_RANGE,
  QUOTE_TTL_SECONDS,
  allKnownChains,
  availableChains,
  chainById,
  planById,
  planCatalog,
  quoteAmountBaseUnits,
  treasuryAddress,
} from "./nation-plans.ts";

// ── Quote creation ────────────────────────────────────────────────────────────

export interface CreateQuoteInput {
  userId: string;
  planId: string;
  chainId: number;
}

export type CreateQuoteResult =
  | { ok: true; quote: Quote }
  | { ok: false; error: string; code: string };

export function createQuote(
  input: CreateQuoteInput,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): CreateQuoteResult {
  const plan = planById(input.planId, env);
  if (!plan) {
    return { ok: false, error: `unknown plan: ${input.planId}`, code: "unknown_plan" };
  }
  const chain = chainById(input.chainId, env);
  if (!chain) {
    return { ok: false, error: `unsupported chain: ${input.chainId}`, code: "unsupported_chain" };
  }
  const receiver = treasuryAddress(chain, env);
  if (!receiver) {
    return { ok: false, error: "payments not configured for this chain", code: "treasury_not_configured" };
  }

  const chains = availableChains(env);
  if (!chains.some((c) => c.chainId === input.chainId)) {
    return { ok: false, error: "payments not available on this chain", code: "chain_unavailable" };
  }

  const dustSuffix = Math.floor(Math.random() * AMOUNT_SUFFIX_RANGE);
  const amountBaseUnits = quoteAmountBaseUnits(plan.usdCents, chain.tokenDecimals, dustSuffix);

  // Human-readable: e.g. "15.000042 USDC"
  const whole = amountBaseUnits / BigInt(10 ** chain.tokenDecimals);
  const frac = amountBaseUnits % BigInt(10 ** chain.tokenDecimals);
  const amountDisplay = `${whole}.${frac.toString().padStart(chain.tokenDecimals, "0")} ${chain.tokenSymbol}`;

  const id = randomId("qte");
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000).toISOString();

  const quote: Quote = {
    id,
    userId: input.userId,
    planId: plan.id,
    chainId: chain.chainId,
    tokenSymbol: chain.tokenSymbol,
    tokenAddress: chain.tokenAddress,
    receiverAddress: receiver,
    amountBaseUnits: amountBaseUnits.toString(),
    amountDisplay,
    dustSuffix,
    createdAt: now.toISOString(),
    expiresAt,
    status: "pending",
  };

  saveQuote(quote);
  return { ok: true, quote };
}

// ── Quote lookup for poller ───────────────────────────────────────────────────

/** Find a pending quote matching an incoming Transfer log. Returns null if no match. */
export function matchTransferToQuote(
  chainId: number,
  to: string,
  amountBaseUnits: bigint,
): Quote | null {
  return findPendingQuoteByAmount(chainId, amountBaseUnits.toString(), to);
}

// ── Payment confirmation ──────────────────────────────────────────────────────

export interface ConfirmPaymentInput {
  quoteId: string;
  txHash: string;
  chainId: number;
  /** Actual amount received, from the tx receipt log. */
  actualAmountBaseUnits: bigint;
  blockNumber: number;
}

export type ConfirmPaymentResult =
  | { ok: true; payment: Payment; entitlement: Entitlement }
  | { ok: false; error: string; code: string };

export function confirmPayment(
  input: ConfirmPaymentInput,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): ConfirmPaymentResult {
  // Idempotency: already credited
  if (paymentExists(input.txHash, input.chainId)) {
    const existing = loadPayment(input.txHash, input.chainId);
    if (existing) {
      const ent = loadEntitlement(existing.userId);
      if (ent) return { ok: true, payment: existing, entitlement: ent };
    }
    return { ok: false, error: "already credited", code: "already_credited" };
  }

  const quote = loadQuote(input.quoteId);
  if (!quote) {
    return { ok: false, error: "quote not found", code: "quote_not_found" };
  }
  if (quote.status !== "pending") {
    return { ok: false, error: `quote is ${quote.status}`, code: "quote_not_pending" };
  }
  if (new Date(quote.expiresAt) <= now) {
    updateQuote(input.quoteId, { status: "expired" });
    return { ok: false, error: "quote has expired", code: "quote_expired" };
  }
  if (quote.chainId !== input.chainId) {
    return { ok: false, error: "chain mismatch", code: "chain_mismatch" };
  }

  const expected = BigInt(quote.amountBaseUnits);
  if (input.actualAmountBaseUnits < expected) {
    return {
      ok: false,
      error: `underpay: received ${input.actualAmountBaseUnits} but expected ${expected}`,
      code: "underpay",
    };
  }
  if (input.actualAmountBaseUnits > expected) {
    console.warn(
      `[nation-billing] overpay on quote ${quote.id}: received ${input.actualAmountBaseUnits}, expected ${expected}`,
    );
  }

  const plan = planById(quote.planId, env);
  if (!plan) {
    return { ok: false, error: "plan no longer available", code: "plan_gone" };
  }
  const chain = chainById(quote.chainId, env);
  if (!chain) {
    return { ok: false, error: "chain configuration missing", code: "chain_missing" };
  }

  const paymentId = randomId("pay");
  const payment: Payment = {
    id: paymentId,
    quoteId: input.quoteId,
    userId: quote.userId,
    planId: quote.planId,
    chainId: input.chainId,
    txHash: input.txHash,
    actualAmountBaseUnits: input.actualAmountBaseUnits.toString(),
    expectedAmountBaseUnits: quote.amountBaseUnits,
    tokenSymbol: quote.tokenSymbol,
    blockNumber: input.blockNumber,
    confirmedAt: now.toISOString(),
    status: "credited",
    creditsGranted: plan.credits,
    entitlementExtendedSeconds: plan.intervalSeconds,
  };

  savePayment(payment);
  updateQuote(input.quoteId, { status: "confirmed", confirmedTxHash: input.txHash, confirmedAt: now.toISOString(), paymentId });

  const entitlement = grantEntitlement(
    quote.userId,
    plan.id,
    plan.label,
    plan.credits,
    plan.intervalSeconds,
    now,
  );

  return { ok: true, payment, entitlement };
}


// ── Public status (client-visible) ───────────────────────────────────────────

export interface NationBillingPublicStatus {
  /** True when at least one chain has a treasury address configured. */
  enabled: boolean;
  plans: Array<{
    id: string;
    label: string;
    usdCents: number;
    credits: number;
    intervalSeconds: number;
  }>;
  chains: Array<{
    chainId: number;
    label: string;
    tokenSymbol: string;
    tokenDecimals: number;
    isTestnet: boolean;
  }>;
}

export function billingPublicStatus(env: NodeJS.ProcessEnv = process.env): NationBillingPublicStatus {
  const chains = availableChains(env);
  const enabled = chains.length > 0;
  return {
    enabled,
    plans: enabled ? planCatalog(env).map(({ id, label, usdCents, credits, intervalSeconds }) => ({
      id, label, usdCents, credits, intervalSeconds,
    })) : [],
    chains: chains.map(({ chainId, label, tokenSymbol, tokenDecimals, isTestnet }) => ({
      chainId, label, tokenSymbol, tokenDecimals, isTestnet,
    })),
  };
}

/** Admin status: includes treasury address presence (never the address value). */
export interface NationBillingAdminStatus extends NationBillingPublicStatus {
  chainsAdmin: Array<{
    chainId: number;
    label: string;
    tokenSymbol: string;
    tokenDecimals: number;
    isTestnet: boolean;
    treasuryConfigured: boolean;
  }>;
  testnetMode: boolean;
}

export function billingAdminStatus(env: NodeJS.ProcessEnv = process.env): NationBillingAdminStatus {
  const { enabled, plans, chains } = billingPublicStatus(env);
  return {
    enabled,
    plans,
    chains,
    chainsAdmin: allKnownChains().map((c) => ({
      chainId: c.chainId,
      label: c.label,
      tokenSymbol: c.tokenSymbol,
      tokenDecimals: c.tokenDecimals,
      isTestnet: c.isTestnet,
      treasuryConfigured: Boolean(treasuryAddress(c, env)),
    })),
    testnetMode: (env.NATION_BILLING_TESTNET ?? "").trim() === "1",
  };
}

// ── Util ──────────────────────────────────────────────────────────────────────

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
