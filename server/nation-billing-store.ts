/**
 * Persistent store for Nation billing: quotes, payments, and entitlements.
 *
 * Storage layout under DATA_DIR/nation-billing/:
 *   quotes/<quoteId>.json       — payment quotes (TTL 30 min)
 *   payments/<txHash>-<chainId>.json  — confirmed payments (idempotency key)
 *   entitlements/<userId>.json  — per-user plan entitlement
 *
 * All writes are atomic (writeFileAtomic). All reads gracefully handle missing
 * files. The store never throws on I/O errors — billing bookkeeping must not
 * crash the server.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

// ── Directories ───────────────────────────────────────────────────────────────

/** Compute the data root lazily so that vi.stubEnv("OMB_DATA_DIR") works in tests. */
function dataRoot(): string {
  return process.env.OMB_DATA_DIR ?? join(homedir(), ".openmausbot");
}

function billingDir(): string {
  const dir = join(dataRoot(), "nation-billing");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function quotesDir(): string {
  const dir = join(billingDir(), "quotes");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function paymentsDir(): string {
  const dir = join(billingDir(), "payments");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function entitlementsDir(): string {
  const dir = join(billingDir(), "entitlements");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type QuoteStatus = "pending" | "confirmed" | "expired" | "cancelled";

export interface Quote {
  id: string;
  userId: string;
  planId: string;
  chainId: number;
  tokenSymbol: string;
  tokenAddress: string;
  receiverAddress: string;
  /** Expected transfer amount in base units (includes dust suffix). */
  amountBaseUnits: string; // stringified bigint
  /** Amount as a human-readable string (e.g. "15.000042 USDC") */
  amountDisplay: string;
  dustSuffix: number;
  createdAt: string; // ISO
  expiresAt: string; // ISO
  status: QuoteStatus;
  /** Set on confirmation */
  confirmedTxHash?: string;
  confirmedAt?: string;
  paymentId?: string;
}

export type PaymentStatus = "confirmed" | "credited";

export interface Payment {
  id: string;
  quoteId: string;
  userId: string;
  planId: string;
  chainId: number;
  txHash: string;
  /** Actual amount received in base units. */
  actualAmountBaseUnits: string;
  /** Expected amount in base units. */
  expectedAmountBaseUnits: string;
  tokenSymbol: string;
  blockNumber: number;
  confirmedAt: string; // ISO
  status: PaymentStatus;
  creditsGranted: number;
  entitlementExtendedSeconds: number;
}

export interface Entitlement {
  userId: string;
  planId: string;
  planLabel: string;
  creditsBalance: number;
  /** ISO timestamp when the plan access expires. */
  expiresAt: string;
  /** ISO timestamp of the last grant. */
  lastGrantedAt: string;
  createdAt: string;
}

// ── Quote helpers ─────────────────────────────────────────────────────────────

function quotePath(id: string): string {
  return join(quotesDir(), `${sanitizeId(id)}.json`);
}

export function saveQuote(quote: Quote): void {
  try {
    writeFileAtomic(quotePath(quote.id), JSON.stringify(quote, null, 2));
  } catch (err) {
    console.error(`[nation-billing] saveQuote failed: ${err}`);
  }
}

export function loadQuote(id: string): Quote | null {
  try {
    const p = quotePath(id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Quote;
  } catch {
    return null;
  }
}

export function updateQuote(id: string, patch: Partial<Quote>): Quote | null {
  const existing = loadQuote(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  saveQuote(updated);
  return updated;
}

export function listQuotes(): Quote[] {
  try {
    return readdirSync(quotesDir())
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(quotesDir(), f), "utf8")) as Quote];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Find pending quotes by (userId, chainId, amountBaseUnits) for dedup. */
export function findPendingQuoteByAmount(
  chainId: number,
  amountBaseUnits: string,
  receiverAddress: string,
): Quote | null {
  const now = new Date();
  return (
    listQuotes().find(
      (q) =>
        q.status === "pending" &&
        q.chainId === chainId &&
        q.amountBaseUnits === amountBaseUnits &&
        q.receiverAddress.toLowerCase() === receiverAddress.toLowerCase() &&
        new Date(q.expiresAt) > now,
    ) ?? null
  );
}

// ── Payment helpers ───────────────────────────────────────────────────────────

function paymentKey(txHash: string, chainId: number): string {
  return `${txHash.toLowerCase().replace(/^0x/, "")}-${chainId}`;
}

function paymentPath(txHash: string, chainId: number): string {
  return join(paymentsDir(), `${sanitizeId(paymentKey(txHash, chainId))}.json`);
}

export function paymentExists(txHash: string, chainId: number): boolean {
  return existsSync(paymentPath(txHash, chainId));
}

export function savePayment(payment: Payment): void {
  try {
    writeFileAtomic(paymentPath(payment.txHash, payment.chainId), JSON.stringify(payment, null, 2));
  } catch (err) {
    console.error(`[nation-billing] savePayment failed: ${err}`);
  }
}

export function loadPayment(txHash: string, chainId: number): Payment | null {
  try {
    const p = paymentPath(txHash, chainId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Payment;
  } catch {
    return null;
  }
}

export function listPayments(): Payment[] {
  try {
    return readdirSync(paymentsDir())
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(paymentsDir(), f), "utf8")) as Payment];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

// ── Entitlement helpers ───────────────────────────────────────────────────────

function entitlementPath(userId: string): string {
  return join(entitlementsDir(), `${sanitizeId(userId)}.json`);
}

export function loadEntitlement(userId: string): Entitlement | null {
  try {
    const p = entitlementPath(userId);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as Entitlement;
  } catch {
    return null;
  }
}

export function saveEntitlement(ent: Entitlement): void {
  try {
    writeFileAtomic(entitlementPath(ent.userId), JSON.stringify(ent, null, 2));
  } catch (err) {
    console.error(`[nation-billing] saveEntitlement failed: ${err}`);
  }
}

export function listEntitlements(): Entitlement[] {
  try {
    return readdirSync(entitlementsDir())
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(entitlementsDir(), f), "utf8")) as Entitlement];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Grant or extend a plan entitlement. Stacks on top of remaining time
 * if the user still has active access (early renewal). */
export function grantEntitlement(
  userId: string,
  planId: string,
  planLabel: string,
  credits: number,
  intervalSeconds: number,
  now = new Date(),
): Entitlement {
  const existing = loadEntitlement(userId);
  const base = existing && new Date(existing.expiresAt) > now
    ? new Date(existing.expiresAt)
    : now;
  const expiresAt = new Date(base.getTime() + intervalSeconds * 1000);
  const creditsBalance = (existing?.creditsBalance ?? 0) + credits;
  const ent: Entitlement = {
    userId,
    planId,
    planLabel,
    creditsBalance,
    expiresAt: expiresAt.toISOString(),
    lastGrantedAt: now.toISOString(),
    createdAt: existing?.createdAt ?? now.toISOString(),
  };
  saveEntitlement(ent);
  return ent;
}

/** Deduct credits from an entitlement. Returns the updated record, or null if
 * the user has no entitlement. Does not throw on insufficient balance — the
 * caller decides whether to refuse the turn. */
export function deductCredits(userId: string, amount: number): Entitlement | null {
  const ent = loadEntitlement(userId);
  if (!ent) return null;
  const updated: Entitlement = { ...ent, creditsBalance: Math.max(0, ent.creditsBalance - amount) };
  saveEntitlement(updated);
  return updated;
}

/** Mark expired entitlements (run daily). Returns the count of expired records. */
export function expireEntitlements(now = new Date()): number {
  let count = 0;
  for (const ent of listEntitlements()) {
    if (new Date(ent.expiresAt) <= now && ent.creditsBalance > 0) {
      saveEntitlement({ ...ent, creditsBalance: 0 });
      count++;
    }
  }
  return count;
}

// ── Util ──────────────────────────────────────────────────────────────────────

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
}
