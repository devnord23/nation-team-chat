// Paying a Full Plans invoice from a NATION wallet: create the wallet from a
// passkey, prepare the exact transfer, have the passkey approve it, and let
// the payment scan credit it. Turnkey and Robinhood Chain are loopback
// stand-ins; the passkey is a Node-built stamp over the real body.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { parseTransaction, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, readBody, setResponseOwner } from "../harness/http.ts";
import { creditAccount, setCreditLedgerForTests } from "../nation-credit-context.ts";
import { CreditLedger, creditChains } from "../nation-credits.ts";
import { scanCreditPayments } from "../nation-payments.ts";
import type { RequestAuth } from "../request-auth.ts";
import { startFakeRobinhoodChain, type FakeChain } from "../testing/fake-robinhood-chain.ts";
import { startFakeTurnkey, type FakeTurnkey } from "../testing/fake-turnkey.ts";
import { apiKeyStamp, TurnkeyClient, turnkeyConfig } from "../turnkey.ts";
import { createNationWalletRoutes, paysInvoice, stampMatchesBody } from "./nation-wallet.ts";
import { dispatchRoutes } from "./table.ts";

const TREASURY = "0x85E3C2D8f776d9D05b14E108F368070CbD8C1639";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const CREDENTIAL = "cred_" + "A".repeat(40);

function member(email: string): RequestAuth {
  const session = { id: randomUUID(), tokenHash: "0".repeat(64), label: "Browser", scopes: ["client"] as const, createdAt: 0, lastSeenAt: 0, expiresAt: Date.now() + 1e9, email, userId: "usr_" + email };
  return { kind: "session", session: { ...session, scopes: ["client"] }, via: "cookie", scopes: ["client"] };
}

/** What a browser's passkey returns for a Turnkey request body. */
function passkeyStamp(body: string, credentialId = CREDENTIAL, challengeOf = body): string {
  const challenge = Buffer.from(createHash("sha256").update(challengeOf).digest("hex"), "utf8").toString("base64url");
  const clientDataJson = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://thenation.city" })).toString("base64url");
  return JSON.stringify({ authenticatorData: "AAAA", clientDataJson, credentialId, signature: "BBBB" });
}

let chain: FakeChain;
let turnkey: FakeTurnkey;
let ledger: CreditLedger;
let lines: string[];
const servers: Server[] = [];

beforeEach(async () => {
  chain = await startFakeRobinhoodChain();
  turnkey = await startFakeTurnkey();
  vi.stubEnv("NATION_TREASURY_ROBINHOOD", TREASURY);
  vi.stubEnv("NATION_RPC_ROBINHOOD", chain.url);
  vi.stubEnv("NATION_TOKEN_USD_PRICE", "");
  vi.stubEnv("NATION_CONFIRMATIONS", "1");
  ledger = new CreditLedger(":memory:");
  setCreditLedgerForTests(ledger);
  lines = [];
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  setCreditLedgerForTests(undefined);
  vi.unstubAllEnvs();
  await chain.close();
  await turnkey.close();
});

async function serve(auth: RequestAuth, withTurnkey = true): Promise<(path: string, body?: unknown) => Promise<{ status: number; body: any }>> {
  const route = createNationWalletRoutes({
    turnkey: () => (withTurnkey ? new TurnkeyClient({ baseUrl: turnkey.url, organizationId: turnkey.organizationId, apiPublicKey: turnkey.apiPublicKey, apiPrivateKey: turnkey.apiPrivateKey }) : null),
    log: (line) => lines.push(line),
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    setResponseOwner(res, false);
    try {
      const handled = await dispatchRoutes([route], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "credit routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

const attestation = { challenge: "Y2hhbGxlbmdlLWNoYWxsZW5nZQ", attestation: { credentialId: CREDENTIAL, clientDataJson: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0", attestationObject: "o2NmbXRkbm9uZWdhdHRTdG10oA", transports: ["AUTHENTICATOR_TRANSPORT_INTERNAL"] } };

async function starterInvoice(auth: RequestAuth) {
  const usdg = creditChains().find((item) => item.symbol === "USDG")!;
  return ledger.createInvoice(creditAccount(auth), usdg, 15, 256n);
}

describe("NATION wallet", () => {
  it("is off without Turnkey credentials, and the credentials must be whole", async () => {
    const call = await serve(member("alice@example.test"), false);
    expect((await call("/api/credits/wallet/embedded")).body).toEqual({ available: false, wallet: null });
    expect((await call("/api/credits/wallet/embedded", attestation)).status).toBe(404);
    expect(turnkeyConfig({ TURNKEY_ORGANIZATION_ID: "org-1", TURNKEY_API_PUBLIC_KEY: "02" + "a".repeat(64) })).toBeNull();
    expect(turnkeyConfig({ TURNKEY_ORGANIZATION_ID: "org-1", TURNKEY_API_PUBLIC_KEY: "02" + "a".repeat(64), TURNKEY_API_PRIVATE_KEY: "b".repeat(64), TURNKEY_API_BASE_URL: "http://evil.example" })).toBeNull();
  });

  it("stamps requests the way Turnkey verifies them, and refuses a mismatched key pair", () => {
    expect(() => apiKeyStamp("{}", "02" + "0".repeat(64), turnkey.apiPrivateKey)).toThrow(/does not match/);
    const stamp = JSON.parse(Buffer.from(apiKeyStamp("{\"a\":1}", turnkey.apiPublicKey, turnkey.apiPrivateKey), "base64url").toString());
    expect(stamp).toMatchObject({ publicKey: turnkey.apiPublicKey, scheme: "SIGNATURE_SCHEME_TK_API_P256" });
    expect(stamp.signature).toMatch(/^30[0-9a-f]+$/); // DER
  });

  it("creates one passkey-held wallet per account, named without the person", async () => {
    const alice = member("alice@example.test");
    const call = await serve(alice);
    const created = await call("/api/credits/wallet/embedded", attestation);
    expect(created.status).toBe(201);
    expect(created.body.wallet.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const request = turnkey.requests[0]!;
    expect(request.stamp).toBe("api-key");
    expect(request.body.parameters.rootUsers[0]).toMatchObject({ apiKeys: [], oauthProviders: [], authenticators: [{ challenge: attestation.challenge, attestation: attestation.attestation }] });
    expect(request.body.parameters).toMatchObject({ rootQuorumThreshold: 1, disableEmailRecovery: true, disableEmailAuth: true, disableSmsAuth: true, disableOtpEmailAuth: true });
    expect(JSON.stringify(request.body)).not.toContain("alice");
    // again: the same wallet, no second sub-organization
    expect((await call("/api/credits/wallet/embedded", attestation)).body.wallet.address).toBe(created.body.wallet.address);
    expect(turnkey.requests).toHaveLength(1);
    // Bob has his own
    const bob = await serve(member("bob@example.test"));
    expect((await bob("/api/credits/wallet/embedded")).body).toEqual({ available: true, wallet: null });
  });

  it("pays a Starter invoice once funded, and the payment scan credits it", async () => {
    const alice = member("alice@example.test");
    const call = await serve(alice);
    const address = (await call("/api/credits/wallet/embedded", attestation)).body.wallet.address as string;
    const invoice = await starterInvoice(alice);

    const empty = await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id });
    expect(empty.status).toBe(409);
    expect(empty.body.error).toContain(`Add USDG to ${address}`);
    chain.fund(USDG, address, BigInt(invoice.amount_micros));
    const noGas = await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id });
    expect(noGas.status).toBe(409);
    expect(noGas.body.error).toMatch(/needs a little ETH/);
    chain.fundEth(address, 10n ** 16n);

    const prepared = await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id });
    expect(prepared.status).toBe(200);
    expect(prepared.body).toMatchObject({ credentialId: CREDENTIAL, symbol: "USDG" });
    const request = JSON.parse(prepared.body.body);
    expect(request).toMatchObject({ type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", parameters: { signWith: address, type: "TRANSACTION_TYPE_ETHEREUM" } });
    expect(request.parameters.unsignedTransaction).not.toMatch(/^0x/);
    expect(paysInvoice(`0x${request.parameters.unsignedTransaction}` as Hex, invoice)).toBe(true);
    expect(parseTransaction(`0x${request.parameters.unsignedTransaction}` as Hex).chainId).toBe(4663);

    const paid = await call("/api/credits/wallet/embedded/pay", { invoiceId: invoice.id, body: prepared.body.body, stamp: passkeyStamp(prepared.body.body) });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(turnkey.requests.at(-1)?.stamp).toBe("passkey");
    expect(chain.balance(USDG, TREASURY)).toBe(BigInt(invoice.amount_micros));

    // The same scan that credits any other wallet's transfer.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await scanCreditPayments(ledger, creditChains(), { log: (line) => lines.push(line) })).toEqual([]);
    expect(ledger.invoice(invoice.id)?.paid_tx).toBe(paid.body.txHash);
    expect(ledger.balance(creditAccount(alice).id)).toBe(invoice.amount_micros);
  });

  it("pays a $NATION invoice in its exact token units (18 decimals, the discount applied)", async () => {
    vi.stubEnv("NATION_TOKEN_USD_PRICE", "0.000286");
    ledger = new CreditLedger(":memory:");
    setCreditLedgerForTests(ledger);
    const alice = member("alice@example.test");
    const call = await serve(alice);
    const address = (await call("/api/credits/wallet/embedded", attestation)).body.wallet.address as string;
    const nation = creditChains().find((item) => item.symbol === "$NATION")!;
    const invoice = ledger.createInvoice(creditAccount(alice), nation, 49, 256n);
    expect(invoice.token_amount).toMatch(/^\d{19,}$/);
    chain.fund(nation.token, address, BigInt(invoice.token_amount));
    chain.fundEth(address, 10n ** 16n);
    const prepared = await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    expect(prepared.body.symbol).toBe("$NATION");
    const paid = await call("/api/credits/wallet/embedded/pay", { invoiceId: invoice.id, body: prepared.body.body, stamp: passkeyStamp(prepared.body.body) });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(chain.balance(nation.token, TREASURY)).toBe(BigInt(invoice.token_amount));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await scanCreditPayments(ledger, creditChains(), { log: (line) => lines.push(line) })).toEqual([]);
    expect(ledger.invoice(invoice.id)?.paid_tx).toBe(paid.body.txHash);
    // The whole pack is credited although less $NATION was sent.
    expect(ledger.balance(creditAccount(alice).id)).toBe(invoice.amount_micros);
  });

  it("forwards nothing that is not exactly this account's invoice transfer", async () => {
    const alice = member("alice@example.test");
    const call = await serve(alice);
    const address = (await call("/api/credits/wallet/embedded", attestation)).body.wallet.address as string;
    const invoice = await starterInvoice(alice);
    chain.fund(USDG, address, 10n ** 12n);
    chain.fundEth(address, 10n ** 16n);
    const prepared = (await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id })).body;
    const request = JSON.parse(prepared.body);
    const signCalls = () => turnkey.requests.filter((item) => item.path.endsWith("sign_transaction")).length;

    // A different amount, to the same treasury.
    const other = await starterInvoice(alice);
    const otherPrepared = JSON.parse((await call("/api/credits/wallet/embedded/prepare", { invoiceId: other.id })).body.body);
    const swapped = JSON.stringify({ ...request, parameters: { ...request.parameters, unsignedTransaction: otherPrepared.parameters.unsignedTransaction } });
    expect((await call("/api/credits/wallet/embedded/pay", { invoiceId: invoice.id, body: swapped, stamp: passkeyStamp(swapped) })).status).toBe(400);
    // Someone else's wallet, or an old request.
    for (const tampered of [
      { ...request, organizationId: randomUUID() },
      { ...request, parameters: { ...request.parameters, signWith: "0x000000000000000000000000000000000000dEaD" } },
      { ...request, timestampMs: String(Date.now() - 11 * 60_000) },
    ]) {
      const body = JSON.stringify(tampered);
      expect((await call("/api/credits/wallet/embedded/pay", { invoiceId: invoice.id, body, stamp: passkeyStamp(body) })).status).toBe(400);
    }
    // A passkey approval for another body.
    expect((await call("/api/credits/wallet/embedded/pay", { invoiceId: invoice.id, body: prepared.body, stamp: passkeyStamp(prepared.body, CREDENTIAL, "{}") })).status).toBe(400);
    expect(signCalls()).toBe(0);
    // Another account's invoice.
    const bobInvoice = await starterInvoice(member("bob@example.test"));
    expect((await call("/api/credits/wallet/embedded/prepare", { invoiceId: bobInvoice.id })).status).toBe(404);
    // A paid or expired one.
    ledger.db.prepare("UPDATE credit_invoices SET expires_at=? WHERE id=?").run(Date.now() - 1, invoice.id);
    expect((await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id })).status).toBe(409);
    expect(chain.sent).toEqual([]);
  });

  it("never broadcasts a signed transaction that pays anything else", async () => {
    const alice = member("alice@example.test");
    const call = await serve(alice);
    const address = (await call("/api/credits/wallet/embedded", attestation)).body.wallet.address as string;
    const invoice = await starterInvoice(alice);
    chain.fund(USDG, address, 10n ** 12n);
    chain.fundEth(address, 10n ** 16n);
    const prepared = (await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id })).body;
    turnkey.mode.evil = true;
    const refused = await call("/api/credits/wallet/embedded/pay", { invoiceId: invoice.id, body: prepared.body, stamp: passkeyStamp(prepared.body) });
    expect(refused.status).toBe(502);
    expect(refused.body.error).toMatch(/nothing was sent/);
    expect(chain.sent).toEqual([]);
    expect(lines.join("\n")).toMatch(/did not match/);
  });

  it("waits for a sign request Turnkey finishes later", async () => {
    const alice = member("alice@example.test");
    const call = await serve(alice);
    const address = (await call("/api/credits/wallet/embedded", attestation)).body.wallet.address as string;
    const invoice = await starterInvoice(alice);
    chain.fund(USDG, address, 10n ** 12n);
    chain.fundEth(address, 10n ** 16n);
    const prepared = (await call("/api/credits/wallet/embedded/prepare", { invoiceId: invoice.id })).body;
    turnkey.mode.pending = true;
    const paid = await call("/api/credits/wallet/embedded/pay", { invoiceId: invoice.id, body: prepared.body, stamp: passkeyStamp(prepared.body) });
    expect(paid.status).toBe(200);
    expect(turnkey.requests.some((item) => item.path.endsWith("get_activity") && item.stamp === "api-key")).toBe(true);
  });

  it("recognizes a passkey approval only for its own body", () => {
    const stamp = JSON.parse(passkeyStamp("{\"a\":1}"));
    expect(stampMatchesBody(stamp, "{\"a\":1}")).toBe(true);
    expect(stampMatchesBody(stamp, "{\"a\":2}")).toBe(false);
    expect(stampMatchesBody({ ...stamp, clientDataJson: "not-json" }, "{\"a\":1}")).toBe(false);
  });
});
