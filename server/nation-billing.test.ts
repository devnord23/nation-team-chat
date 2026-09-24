/**
 * Tests for Nation billing: quote creation, payment confirmation, entitlement
 * stacking, idempotency, underpay, overpay, and expiry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each test gets its own isolated data directory so tests never share state.
let testDataDir: string;
let testEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  testDataDir = join(tmpdir(), `nation-billing-test-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDataDir, { recursive: true });
  testEnv = {
    OMB_DATA_DIR: testDataDir,
    NATION_BILLING_TESTNET: "1",
    // Treasury configured so chains are available
    NATION_TREASURY_BASE: "0xDEADbEEf00000000000000000000000000000001",
    NATION_TREASURY_ROBINHOOD: "0xDEADbEEf00000000000000000000000000000002",
  };
  // Override DATA_DIR used by billing store for this test
  vi.stubEnv("OMB_DATA_DIR", testDataDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  try { rmSync(testDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Helpers that re-import with the test env ──────────────────────────────────
// We import the modules fresh to pick up vi.stubEnv. Since DATA_DIR is read
// at module init time from process.env, we must re-import inside each test
// group using dynamic import with the env already stubbed.

async function getBillingModule() {
  const mod = await import("./nation-billing.ts");
  return mod as typeof import("./nation-billing.ts");
}

async function getStoreModule() {
  const mod = await import("./nation-billing-store.ts");
  return mod as typeof import("./nation-billing-store.ts");
}

async function getPlansModule() {
  const mod = await import("./nation-plans.ts");
  return mod as typeof import("./nation-plans.ts");
}

// ── Plan catalog ──────────────────────────────────────────────────────────────

describe("planCatalog", () => {
  it("returns default plans", async () => {
    const { planCatalog } = await getPlansModule();
    const plans = planCatalog({});
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect(plan.usdCents).toBeGreaterThan(0);
      expect(plan.credits).toBeGreaterThan(0);
      expect(plan.intervalSeconds).toBe(30 * 24 * 3600);
    }
  });

  it("respects env overrides", async () => {
    const { planCatalog } = await getPlansModule();
    const plans = planCatalog({ NATION_PLAN_STARTER_USD_CENTS: "2500", NATION_PLAN_STARTER_CREDITS: "1000" });
    const starter = plans.find((p) => p.id === "starter");
    expect(starter?.usdCents).toBe(2500);
    expect(starter?.credits).toBe(1000);
  });
});

// ── Amount base units ─────────────────────────────────────────────────────────

describe("quoteAmountBaseUnits", () => {
  it("converts $15 plan to 15_000_000 + dust for 6-decimal token", async () => {
    const { quoteAmountBaseUnits } = await getPlansModule();
    // $15.00 = 1500 cents; 6 decimals → 15_000_000 base units
    const amount = quoteAmountBaseUnits(1500, 6, 0);
    expect(amount).toBe(15_000_000n);
  });

  it("adds dust suffix", async () => {
    const { quoteAmountBaseUnits } = await getPlansModule();
    const amount = quoteAmountBaseUnits(1500, 6, 42);
    expect(amount).toBe(15_000_042n);
  });
});

// ── Quote creation ────────────────────────────────────────────────────────────

describe("createQuote", () => {
  it("creates a valid quote", async () => {
    const { createQuote } = await getBillingModule();
    const result = createQuote({ userId: "user@example.com", planId: "starter", chainId: 84532 }, testEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quote.userId).toBe("user@example.com");
    expect(result.quote.planId).toBe("starter");
    expect(result.quote.chainId).toBe(84532);
    expect(result.quote.status).toBe("pending");
    expect(result.quote.amountBaseUnits).toBeTruthy();
    expect(result.quote.receiverAddress).toBe("0xDEADbEEf00000000000000000000000000000001");
    // amount display should mention USDC
    expect(result.quote.amountDisplay).toContain("USDC");
  });

  it("rejects unknown plan", async () => {
    const { createQuote } = await getBillingModule();
    const result = createQuote({ userId: "u", planId: "nonexistent", chainId: 84532 }, testEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unknown_plan");
  });

  it("rejects unsupported chain", async () => {
    const { createQuote } = await getBillingModule();
    const result = createQuote({ userId: "u", planId: "starter", chainId: 99999 }, testEnv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_chain");
  });

  it("rejects when no treasury configured", async () => {
    const { createQuote } = await getBillingModule();
    const envNoTreasury = { ...testEnv, NATION_TREASURY_BASE: "" };
    const result = createQuote({ userId: "u", planId: "starter", chainId: 84532 }, envNoTreasury);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("treasury_not_configured");
  });
});

// ── Payment confirmation ──────────────────────────────────────────────────────

describe("confirmPayment", () => {
  async function makeQuote() {
    const { createQuote } = await getBillingModule();
    const result = createQuote({ userId: "alice@example.com", planId: "starter", chainId: 84532 }, testEnv);
    if (!result.ok) throw new Error("quote creation failed");
    return result.quote;
  }

  it("credits exact payment", async () => {
    const { confirmPayment } = await getBillingModule();
    const quote = await makeQuote();
    const result = confirmPayment(
      {
        quoteId: quote.id,
        txHash: "0xabc123",
        chainId: 84532,
        actualAmountBaseUnits: BigInt(quote.amountBaseUnits),
        blockNumber: 100,
      },
      testEnv,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entitlement.userId).toBe("alice@example.com");
    expect(result.entitlement.planId).toBe("starter");
    expect(result.entitlement.creditsBalance).toBeGreaterThan(0);
    expect(new Date(result.entitlement.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("is idempotent — double credit does not add extra credits", async () => {
    const { confirmPayment } = await getBillingModule();
    const { loadEntitlement } = await getStoreModule();
    const quote = await makeQuote();
    const input = {
      quoteId: quote.id,
      txHash: "0xdup002",
      chainId: 84532,
      actualAmountBaseUnits: BigInt(quote.amountBaseUnits),
      blockNumber: 101,
    };
    const first = confirmPayment(input, testEnv);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const balanceAfterFirst = first.entitlement.creditsBalance;

    // Second call with the same txHash: returns ok:true (idempotent — safe to
    // re-confirm) but must not add credits again.
    const second = confirmPayment(input, testEnv);
    expect(second.ok).toBe(true);

    // Balance must not have changed — only credited once.
    const ent = loadEntitlement(quote.userId);
    expect(ent?.creditsBalance).toBe(balanceAfterFirst);
  });

  it("rejects underpay", async () => {
    const { confirmPayment } = await getBillingModule();
    const quote = await makeQuote();
    const result = confirmPayment(
      {
        quoteId: quote.id,
        txHash: "0xunderpay",
        chainId: 84532,
        actualAmountBaseUnits: BigInt(quote.amountBaseUnits) - 1n,
        blockNumber: 102,
      },
      testEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("underpay");
  });

  it("accepts overpay with a warning", async () => {
    const { confirmPayment } = await getBillingModule();
    const quote = await makeQuote();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = confirmPayment(
      {
        quoteId: quote.id,
        txHash: "0xoverpay",
        chainId: 84532,
        actualAmountBaseUnits: BigInt(quote.amountBaseUnits) + 1000n,
        blockNumber: 103,
      },
      testEnv,
    );
    expect(result.ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("overpay"));
    warnSpy.mockRestore();
  });

  it("rejects expired quote", async () => {
    const { confirmPayment } = await getBillingModule();
    const { loadQuote, saveQuote } = await getStoreModule();

    const quote = await makeQuote();
    // Expire the quote
    const expired = loadQuote(quote.id)!;
    saveQuote({ ...expired, expiresAt: new Date(Date.now() - 1000).toISOString() });

    const result = confirmPayment(
      {
        quoteId: quote.id,
        txHash: "0xexpired",
        chainId: 84532,
        actualAmountBaseUnits: BigInt(quote.amountBaseUnits),
        blockNumber: 104,
      },
      testEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("quote_expired");
  });

  it("rejects chain mismatch", async () => {
    const { confirmPayment } = await getBillingModule();
    const quote = await makeQuote();
    const result = confirmPayment(
      {
        quoteId: quote.id,
        txHash: "0xchainmismatch",
        chainId: 8453, // wrong chain (mainnet instead of sepolia)
        actualAmountBaseUnits: BigInt(quote.amountBaseUnits),
        blockNumber: 105,
      },
      testEnv,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("chain_mismatch");
  });
});

// ── Entitlement stacking ──────────────────────────────────────────────────────

describe("grantEntitlement (stacking)", () => {
  it("stacks credits and extends time on early renewal", async () => {
    const { grantEntitlement } = await getStoreModule();
    const now = new Date("2026-01-01T00:00:00Z");
    const interval = 30 * 24 * 3600; // 30 days

    // First grant
    const first = grantEntitlement("bob@example.com", "starter", "Starter", 500, interval, now);
    expect(first.creditsBalance).toBe(500);
    const exp1 = new Date(first.expiresAt);
    expect(exp1.getTime()).toBeCloseTo(now.getTime() + interval * 1000, -3);

    // Early renewal (15 days later — still within the 30-day window)
    const renewal = new Date("2026-01-16T00:00:00Z");
    const second = grantEntitlement("bob@example.com", "starter", "Starter", 500, interval, renewal);
    expect(second.creditsBalance).toBe(1000); // stacked
    // New expiry = old expiry + 30 days (stacked on top of remaining time)
    const exp2 = new Date(second.expiresAt);
    expect(exp2.getTime()).toBeGreaterThan(exp1.getTime());
    expect(exp2.getTime()).toBeCloseTo(exp1.getTime() + interval * 1000, -3);
  });

  it("starts fresh expiry if previous plan already expired", async () => {
    const { grantEntitlement } = await getStoreModule();
    const past = new Date("2025-06-01T00:00:00Z");
    const interval = 30 * 24 * 3600;

    // Grant and expire
    const first = grantEntitlement("carol@example.com", "starter", "Starter", 100, interval, past);
    expect(first.creditsBalance).toBe(100);

    // Grant again now (well after expiry)
    const now = new Date("2026-01-01T00:00:00Z");
    const second = grantEntitlement("carol@example.com", "pro", "Pro", 500, interval, now);
    // Credits from expired plan (creditsBalance was 100) + new credits
    expect(second.creditsBalance).toBe(600);
    // Expiry from now, not from old expiry
    const exp = new Date(second.expiresAt);
    expect(exp.getTime()).toBeCloseTo(now.getTime() + interval * 1000, -3);
  });
});

// ── expireEntitlements ────────────────────────────────────────────────────────

describe("expireEntitlements", () => {
  it("zeroes credits for expired records", async () => {
    const { grantEntitlement, expireEntitlements, loadEntitlement } = await getStoreModule();
    const past = new Date("2025-01-01T00:00:00Z");
    grantEntitlement("dave@example.com", "starter", "Starter", 500, 1, past); // 1-second interval

    const now = new Date("2026-01-01T00:00:00Z");
    const count = expireEntitlements(now);
    expect(count).toBe(1);
    const ent = loadEntitlement("dave@example.com");
    expect(ent?.creditsBalance).toBe(0);
  });

  it("does not expire active records", async () => {
    const { grantEntitlement, expireEntitlements, loadEntitlement } = await getStoreModule();
    const now = new Date();
    grantEntitlement("eve@example.com", "starter", "Starter", 500, 30 * 24 * 3600, now);

    const expired = expireEntitlements(now);
    expect(expired).toBe(0);
    const ent = loadEntitlement("eve@example.com");
    expect(ent?.creditsBalance).toBe(500);
  });
});

// ── Quote matching for poller ─────────────────────────────────────────────────

describe("matchTransferToQuote", () => {
  it("finds a pending quote by chain/amount/receiver", async () => {
    const { createQuote, matchTransferToQuote } = await getBillingModule();
    const result = createQuote({ userId: "frank@example.com", planId: "starter", chainId: 84532 }, testEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const found = matchTransferToQuote(
      84532,
      result.quote.receiverAddress,
      BigInt(result.quote.amountBaseUnits),
    );
    expect(found).not.toBeNull();
    expect(found?.id).toBe(result.quote.id);
  });

  it("returns null for wrong amount", async () => {
    const { createQuote, matchTransferToQuote } = await getBillingModule();
    const result = createQuote({ userId: "grace@example.com", planId: "starter", chainId: 84532 }, testEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const found = matchTransferToQuote(84532, result.quote.receiverAddress, 1n);
    expect(found).toBeNull();
  });

  it("returns null for wrong chain", async () => {
    const { createQuote, matchTransferToQuote } = await getBillingModule();
    const result = createQuote({ userId: "hank@example.com", planId: "starter", chainId: 84532 }, testEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const found = matchTransferToQuote(
      99999,
      result.quote.receiverAddress,
      BigInt(result.quote.amountBaseUnits),
    );
    expect(found).toBeNull();
  });
});

// ── billingPublicStatus ───────────────────────────────────────────────────────

describe("billingPublicStatus", () => {
  it("enabled when treasury configured", async () => {
    const { billingPublicStatus } = await getBillingModule();
    const status = billingPublicStatus(testEnv);
    expect(status.enabled).toBe(true);
    expect(status.plans.length).toBeGreaterThan(0);
    expect(status.chains.length).toBeGreaterThan(0);
  });

  it("disabled when no treasury configured", async () => {
    const { billingPublicStatus } = await getBillingModule();
    const status = billingPublicStatus({
      NATION_BILLING_TESTNET: "1",
      NATION_TREASURY_BASE: "",
      NATION_TREASURY_ROBINHOOD: "",
    });
    expect(status.enabled).toBe(false);
    expect(status.plans).toEqual([]);
    expect(status.chains).toEqual([]);
  });
});
