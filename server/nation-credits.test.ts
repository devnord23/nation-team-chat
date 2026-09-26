import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, type Hex } from "viem";
import { CreditLedger, creditSettings, creditChains, invoiceChain, invoiceTokenAmount, micros, type CreditAccount, type CreditChain, type CreditInvoice } from "./nation-credits.ts";
import { confirmCreditPayment, verifyCreditPayment, type PaymentRpc } from "./nation-payments.ts";

const ledgers: CreditLedger[] = [], roots: string[] = [];
afterEach(() => { ledgers.splice(0).forEach(ledger => ledger.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const account = (id = "verified-1"): CreditAccount => ({ id, verified: true, email: `${id}@example.test` });
const ledger = (env: NodeJS.ProcessEnv = {}) => { const value = new CreditLedger(":memory:", creditSettings(env), env); ledgers.push(value); return value; };
const treasury = "0x1111111111111111111111111111111111111111";
const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const nationToken = "0xc839a88a05b231515a82c71ee97b4f18973c1340";
const tx = (digit = "a") => ("0x" + digit.repeat(64)) as Hex;
const usdcChain: CreditChain = { id: 8453, name: "Base", symbol: "USDC", treasury, token, rpc: "http://127.0.0.1", decimals: 6 };
const nationChain: CreditChain = { id: 4663, name: "Robinhood Chain", symbol: "$NATION", treasury, token: nationToken, rpc: "http://127.0.0.1", decimals: 18 };
const event = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const invoice = (value: CreditLedger, id = "verified-1") => value.createInvoice(account(id), usdcChain, 15, 10n, 1_000_000);
function rpc(inv: CreditInvoice, overrides: Partial<PaymentRpc> = {}): PaymentRpc {
  return {
    getChainId: async () => 8453, getBlockNumber: async () => 12n,
    getBlock: async () => ({ hash: tx("b"), timestamp: 1001n }),
    getTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash, blockNumber: 10n, blockHash: tx("b"), logs: [{ address: token,
      topics: encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: "0x2222222222222222222222222222222222222222", to: treasury } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [BigInt(inv.token_amount || inv.amount_micros)]),
    }] }), ...overrides,
  };
}
describe("credit ledger", () => {
  it("validates new defaults (15,49,99) and returns structured tiers; missing treasuries hide top up", () => {
    const settings = creditSettings({});
    expect(settings).toMatchObject({ freeUsd: 3, markup: 1, lowUsd: .5, packs: [15,49,99], grantsPerIp: 2, confirmations: 3 });
    expect(settings.tiers).toHaveLength(3);
    expect(settings.tiers[0]).toMatchObject({ id: "starter", name: "Starter", usd: 15, popular: false });
    expect(settings.tiers[1]).toMatchObject({ id: "builder", name: "Builder", usd: 49, popular: true });
    expect(settings.tiers[2]).toMatchObject({ id: "swarm",   name: "Swarm",   usd: 99, popular: false });
    for (const free of ["1", "6", "NaN", ""]) expect(() => creditSettings({ NATION_FREE_CREDIT_USD: free })).toThrow();
    expect(creditChains({})).toEqual([]);
    // Base (8453) is removed from the top-up path; NATION_TREASURY_BASE is ignored.
    expect(creditChains({ NATION_TREASURY_BASE: "invalid" })).toEqual([]);
    expect(creditChains({ NATION_TREASURY_BASE: treasury })).toEqual([]);
    expect(creditChains({ NATION_TREASURY_ROBINHOOD: treasury })[0]).toMatchObject({ id: 4663, symbol: "USDG" });
  });

  it("includes $NATION chain when NATION_TOKEN_USD_PRICE is set alongside a treasury", () => {
    const chains = creditChains({ NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.50" });
    const nationEntry = chains.find(c => c.symbol === "$NATION");
    expect(nationEntry).toBeDefined();
    expect(nationEntry).toMatchObject({ id: 4663, decimals: 18, token: nationToken.toLowerCase() });
    // USDG is still present
    expect(chains.find(c => c.symbol === "USDG")).toBeDefined();
    // Without the price env, no NATION chain
    const noNation = creditChains({ NATION_TREASURY_ROBINHOOD: treasury });
    expect(noNation.find(c => c.symbol === "$NATION")).toBeUndefined();
  });

  it("resolves an invoice's token on the shared Robinhood chain id; token-less requests get USDG", () => {
    const chains = creditChains({ NATION_TREASURY_ROBINHOOD: treasury, NATION_TOKEN_USD_PRICE: "0.000286" });
    // $NATION is listed first, so a lookup by chain id alone would bill a USDG buyer in $NATION.
    expect(chains.map(c => c.symbol)).toEqual(["$NATION", "USDG"]);
    expect(invoiceChain(chains, 4663)).toMatchObject({ symbol: "USDG", decimals: 6 });
    expect(invoiceChain(chains, 4663, "0xc839A88A05B231515a82c71EE97b4F18973C1340")).toMatchObject({ symbol: "$NATION", decimals: 18 });
    expect(invoiceChain(chains, 4663, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168")).toMatchObject({ symbol: "USDG" });
    // A token that is not offered on that chain, or a dropped chain, never falls back to another entry.
    expect(invoiceChain(chains, 4663, token)).toBeUndefined();
    expect(invoiceChain(chains, 8453)).toBeUndefined();
    expect(invoiceChain(creditChains({ NATION_TREASURY_ROBINHOOD: treasury }), 4663, nationToken)).toBeUndefined();
  });

  it("computes token_amount correctly for USDC (6 dec) and $NATION (18 dec)", () => {
    const amountMicros = 15_500_000;
    // USDC: token_amount == amount_micros
    expect(invoiceTokenAmount(amountMicros, usdcChain, {})).toBe(String(amountMicros));
    // NATION @ $0.50: 15.5 / 0.50 = 31 NATION = 31e18 units
    const nationAmt = invoiceTokenAmount(amountMicros, nationChain, { NATION_TOKEN_USD_PRICE: "0.50" });
    expect(BigInt(nationAmt)).toBe(31_000_000_000_000_000_000n);
    // Missing price throws
    expect(() => invoiceTokenAmount(amountMicros, nationChain, {})).toThrow("NATION_TOKEN_USD_PRICE");
  });

  it("stores token_amount on NATION invoices and '' for USDC invoices", () => {
    const db = ledger({ NATION_PACKS_USD: "15,49,99", NATION_TOKEN_USD_PRICE: "0.50" });
    db.account(account());
    // USDC invoice
    const usdcInv = db.createInvoice(account(), usdcChain, 15, 1n);
    expect(usdcInv.token_amount).toBe(String(usdcInv.amount_micros));
    // NATION invoice
    const nationInv = db.createInvoice(account(), nationChain, 15, 1n);
    expect(nationInv.token_amount).not.toBe("");
    expect(BigInt(nationInv.token_amount)).toBeGreaterThan(0n);
  });

  it("grants once per verified account and requires real account verification", () => {
    const db = ledger();
    expect(db.grant({ id: "unverified", verified: false }, "ip", "device").granted).toBe(false);
    expect(db.grant(account(), "ip", "device").granted).toBe(true);
    expect(db.grant(account(), "other-ip", "other-device").granted).toBe(false);
    expect(db.balance(account().id)).toBe(micros(3));
    expect(db.admin().ledger).toHaveLength(1);
  });
  it("enforces IP/day and lifetime device limits and rejects disposable email domains", () => {
    const db = ledger(), now = Date.UTC(2026, 8, 24);
    expect(db.grant(account("a"), "same-ip", "a", now).granted).toBe(true);
    expect(db.grant(account("b"), "same-ip", "b", now).granted).toBe(true);
    expect(db.grant(account("c"), "same-ip", "c", now).granted).toBe(false);
    expect(db.grant(account("d"), "other-ip", "a", now).granted).toBe(false);
    expect(db.grant(account("c"), "same-ip", "c", now + 86_400_000).granted).toBe(true);
    expect(db.grant({ ...account("temp"), email: "new@sub.mailinator.com" }, "fresh-ip", "fresh-device", now).granted).toBe(false);
  });
  it("debits actual cost times markup once, blocks zero, and retains in-flight overruns", () => {
    const db = ledger({ NATION_CREDIT_MARKUP: "1.25" }); db.grant(account(), "ip", "device");
    const call = db.beginCall(account()); db.settle(call, .48); db.settle(call, .48);
    expect(db.balance(account().id)).toBe(micros(2.4));
    db.settle(db.beginCall(account()), 2);
    expect(db.balance(account().id)).toBe(micros(-.1));
    expect(() => db.beginCall(account())).toThrow("top up");
    expect(db.admin().ledger.filter(row => row.type === "usage")).toHaveLength(2);
  });
  it("records actual operator cost without charging privileged accounts", () => {
    const db = ledger(); const owner = { id: "owner", verified: true, exempt: true };
    db.settle(db.beginCall(owner), 5);
    expect(db.balance("owner")).toBe(0);
    expect(db.admin().ledger[0]).toMatchObject({ amount_micros: 0, cost_micros: micros(5) });
  });
  it("keeps unknown costs pending and unblocks only after actual-cost settlement", () => {
    const db = ledger(); db.grant(account(), "ip", "device");
    const call = db.beginCall(account()); db.markUnconfirmed(call);
    expect(() => db.beginCall(account())).toThrow("cost confirmation");
    db.settle(call, .1);
    expect(() => db.assertAvailable(account())).not.toThrow();
  });
  it("persists credit indefinitely across database reopen and late invoice settlement", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const file = join(root, "credits.db"), first = new CreditLedger(file, creditSettings({}));
    first.grant(account(), "ip", "device", 0); const inv = invoice(first);
    first.paid(inv, tx(), inv.amount_micros, inv.expires_at + 365 * 86_400_000);
    const balance = first.balance(account().id); first.close();
    const second = new CreditLedger(file, creditSettings({})); ledgers.push(second);
    expect(second.balance(account().id)).toBe(balance);
    expect(second.invoice(inv.id)?.paid_tx).toBe(tx());
  });
  it("blocks abandoned calls after restart until the actual cost is reconciled", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const file = join(root, "credits.db"), first = new CreditLedger(file, creditSettings({}));
    first.grant(account(), "ip", "device"); const call = first.beginCall(account()); first.close();
    const second = new CreditLedger(file, creditSettings({})); ledgers.push(second);
    expect(() => second.beginCall(account())).toThrow("cost confirmation");
    second.settle(call, .2);
    expect(second.balance(account().id)).toBe(micros(2.8));
    expect(() => second.assertAvailable(account())).not.toThrow();
  });
  it("serializes unique grants across independent database handles", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const file = join(root, "credits.db"), first = new CreditLedger(file, creditSettings({})), second = new CreditLedger(file, creditSettings({})); ledgers.push(first, second);
    expect(first.grant(account(), "ip", "device").granted).toBe(true);
    expect(second.grant(account(), "other", "other").granted).toBe(false);
    expect(second.balance(account().id)).toBe(micros(3));
  });
  it("requires reasons for manual adjustments and prevents negative manual balances", () => {
    const db = ledger(); db.account(account());
    expect(() => db.adjust(account().id, 10, "", "owner")).toThrow();
    db.adjust(account().id, 10, "Support refund", "owner");
    db.adjust(account().id, -2, "Correct duplicate support refund", "owner");
    expect(db.balance(account().id)).toBe(micros(8));
    expect(() => db.adjust(account().id, -9, "Cannot overdraw", "owner")).toThrow();
  });
  it("migrates existing database without token_amount column", () => {
    const root = mkdtempSync(join(tmpdir(), "nation-credit-test-")); roots.push(root);
    const { DatabaseSync } = require("node:sqlite");
    const file = join(root, "legacy.db");
    // Build a legacy schema (no token_amount column)
    const legacyDb = new DatabaseSync(file);
    legacyDb.exec(`
      CREATE TABLE credit_accounts(id TEXT PRIMARY KEY, verified INTEGER NOT NULL, exempt INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE credit_invoices(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chain INTEGER NOT NULL, treasury TEXT NOT NULL, token TEXT NOT NULL, pack_micros INTEGER NOT NULL, amount_micros INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, paid_tx TEXT UNIQUE, from_block TEXT NOT NULL, UNIQUE(chain,amount_micros));
      CREATE TABLE credit_ledger(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('free','purchase','usage','refund')), amount_micros INTEGER NOT NULL, cost_micros INTEGER NOT NULL DEFAULT 0, tx_hash TEXT UNIQUE, chain INTEGER, reference TEXT UNIQUE, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE credit_grants(user_id TEXT PRIMARY KEY, ip_hash TEXT NOT NULL, device_hash TEXT NOT NULL UNIQUE, day TEXT NOT NULL);
      CREATE TABLE credit_wallets(session_id TEXT PRIMARY KEY, address TEXT NOT NULL);
      CREATE TABLE credit_challenges(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE credit_calls(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL, provider_id TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE credit_sponsors(thread_id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
      CREATE TABLE credit_cursors(chain INTEGER PRIMARY KEY, block TEXT NOT NULL);
    `);
    legacyDb.close();
    // Opening with new CreditLedger should not throw (migration adds token_amount)
    const migrated = new CreditLedger(file, creditSettings({})); ledgers.push(migrated);
    migrated.account(account());
    const inv = migrated.createInvoice(account(), usdcChain, 15, 1n);
    expect(inv.token_amount).toBeDefined();
  });
});
describe("server-side transfer verification", () => {
  it("credits a valid exact transfer only once, with no invoice time expiry loss", async () => {
    const db = ledger(), inv = invoice(db);
    await confirmCreditPayment(db, inv, tx(), rpc(inv));
    expect(db.balance(inv.user_id)).toBe(inv.amount_micros);
    await expect(confirmCreditPayment(db, inv, tx(), rpc(inv))).rejects.toThrow("already");
    const other = invoice(db, "second");
    expect(() => db.paid(other, tx(), other.amount_micros)).toThrow("already");
  });
  it("rejects wrong networks, failed receipts, pending confirmations and reorgs", async () => {
    const inv = invoice(ledger());
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getChainId: async () => 4663 }), 3)).rejects.toThrow("network");
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getBlockNumber: async () => 11n }), 3)).rejects.toThrow("confirming");
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getBlock: async () => ({ hash: tx("c"), timestamp: 1001n }) }), 3)).rejects.toThrow("confirming");
    const base = rpc(inv);
    await expect(verifyCreditPayment(inv, tx(), rpc(inv, { getTransactionReceipt: async args => ({ ...await base.getTransactionReceipt(args), status: "reverted" }) }), 3)).rejects.toThrow("successful");
  });
  it.each(["wrong-token", "wrong-treasury", "too-small", "wrong-suffix"])("rejects %s", async kind => {
    const inv = invoice(ledger()), base = rpc(inv);
    const bad = rpc(inv, { getTransactionReceipt: async args => {
      const receipt = await base.getTransactionReceipt(args); const log = { ...receipt.logs[0]! };
      if (kind === "wrong-token") log.address = treasury;
      if (kind === "wrong-treasury") log.topics = encodeEventTopics({ abi: [event], eventName: "Transfer", args: { from: treasury, to: token as Hex } }) as Hex[];
      if (kind === "too-small" || kind === "wrong-suffix") log.data = encodeAbiParameters([{ type: "uint256" }], [BigInt(kind === "too-small" ? inv.pack_micros - 1 : inv.amount_micros + 1)]);
      return { ...receipt, logs: [log] };
    } });
    await expect(verifyCreditPayment(inv, tx(), bad, 3)).rejects.toThrow("does not match");
  });
});
