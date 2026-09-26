// The NATION wallet (server/turnkey.ts): an embedded wallet per account,
// held by the person's passkey, that pays Full Plans invoices on Robinhood
// Chain without a browser extension.
//
//   GET  /api/credits/wallet/embedded          on or off here, and this account's wallet and balances
//   POST /api/credits/wallet/embedded          create it from a new passkey
//   POST /api/credits/wallet/embedded/prepare  the exact sign request for one open payment request
//   POST /api/credits/wallet/embedded/pay      submit that request, stamped by the passkey, and broadcast
//
// This server never holds a key that can move the wallet's funds. What it
// does hold is the line between "sign this" and "pay this invoice": a sign
// request is forwarded only when it is for the account's own wallet and its
// transaction is exactly the invoice's transfer (the token, the treasury,
// the amount, Robinhood Chain), and the signed result is checked again
// before it is broadcast. The existing payment scan credits it, as it
// credits a transfer from any other wallet.
import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionData, formatUnits, getAddress, parseAbi, parseTransaction, recoverTransactionAddress, serializeTransaction, type Hex } from "viem";
import { z } from "zod";
import { PASS, type RouteHandler } from "./table.ts";
import { creditAccount, nationLedger } from "../nation-credit-context.ts";
import { creditChains, creditError, type CreditChain, type CreditInvoice } from "../nation-credits.ts";
import { chainClient } from "../nation-payments.ts";
import { TurnkeyClient, TurnkeyError, turnkeyConfig } from "../turnkey.ts";

const ERC20 = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
const TRANSPORTS = ["AUTHENTICATOR_TRANSPORT_BLE", "AUTHENTICATOR_TRANSPORT_INTERNAL", "AUTHENTICATOR_TRANSPORT_NFC", "AUTHENTICATOR_TRANSPORT_USB", "AUTHENTICATOR_TRANSPORT_HYBRID"] as const;
const base64url = (max: number) => z.string().regex(new RegExp(`^[A-Za-z0-9_-]{16,${max}}$`));
const createSchema = z.object({
  challenge: base64url(128),
  attestation: z.object({
    credentialId: base64url(1400),
    clientDataJson: base64url(4096),
    attestationObject: base64url(16384),
    transports: z.array(z.enum(TRANSPORTS)).max(5),
  }).strict(),
}).strict();
const prepareSchema = z.object({ invoiceId: z.string().uuid() }).strict();
const paySchema = z.object({ invoiceId: z.string().uuid(), body: z.string().min(2).max(8192), stamp: z.string().min(2).max(16384) }).strict();
const stampSchema = z.object({ authenticatorData: z.string(), clientDataJson: z.string(), credentialId: z.string(), signature: z.string() }).strict();
/** How long a prepared sign request may wait for the passkey. */
const SIGN_WINDOW_MS = 10 * 60_000;

interface WalletRow { account_id: string; sub_org_id: string; wallet_id: string; address: string; credential_id: string; created_at: number }

const hexOfSha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The transfer an invoice expects: its token contract, to its treasury, exactly its amount. */
export function invoiceTransfer(invoice: CreditInvoice): { to: Hex; data: Hex; units: bigint } {
  const units = BigInt(invoice.token_amount || invoice.amount_micros);
  return {
    to: getAddress(invoice.token),
    data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [getAddress(invoice.treasury), units] }),
    units,
  };
}

/** Whether a (signed or unsigned) serialized transaction is exactly the invoice's transfer on its chain. */
export function paysInvoice(serialized: Hex, invoice: CreditInvoice): boolean {
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(serialized);
  } catch {
    return false;
  }
  if (tx.type !== "eip1559" || tx.chainId !== invoice.chain || (tx.value ?? 0n) !== 0n || !tx.to || !tx.data) return false;
  if (tx.to.toLowerCase() !== invoice.token.toLowerCase()) return false;
  try {
    const call = decodeFunctionData({ abi: ERC20, data: tx.data });
    const expected = invoiceTransfer(invoice);
    return call.functionName === "transfer" && call.args[0].toLowerCase() === invoice.treasury.toLowerCase() && call.args[1] === expected.units;
  } catch {
    return false;
  }
}

/** The challenge a passkey signs for a Turnkey request: the UTF-8 bytes of hex(sha256(body)), base64url in clientDataJSON. */
export function stampMatchesBody(stamp: z.infer<typeof stampSchema>, body: string): boolean {
  try {
    const client = JSON.parse(Buffer.from(stamp.clientDataJson, "base64url").toString("utf8")) as { type?: unknown; challenge?: unknown };
    return client.type === "webauthn.get" && client.challenge === Buffer.from(hexOfSha256(body), "utf8").toString("base64url");
  } catch {
    return false;
  }
}

export function createNationWalletRoutes(options: { turnkey?: () => TurnkeyClient | null; log?: (line: string) => void } = {}): RouteHandler {
  const log = options.log ?? ((line: string) => console.warn(line));
  const turnkey = options.turnkey ?? (() => {
    const config = turnkeyConfig();
    return config ? new TurnkeyClient(config) : null;
  });
  const paying = new Set<string>();

  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path !== "/api/credits/wallet/embedded" && !path.startsWith("/api/credits/wallet/embedded/")) return PASS;
    res.setHeader("cache-control", "no-store");
    const ledger = nationLedger();
    const account = creditAccount(auth);
    const client = turnkey();
    const chains = creditChains();
    const wallet = () => ledger.db.prepare("SELECT * FROM credit_embedded_wallets WHERE account_id=?").get(account.id) as unknown as WalletRow | undefined;

    if (path === "/api/credits/wallet/embedded" && method === "GET") {
      const row = client && account.verified ? wallet() : undefined;
      if (!row) return json(res, 200, { available: Boolean(client) && account.verified && chains.length > 0, wallet: null });
      return json(res, 200, { available: true, wallet: { address: getAddress(row.address), credentialId: row.credential_id, balances: await balances(row.address, chains) } });
    }
    if (!client || !chains.length) throw creditError("The NATION wallet is not available here yet.", 404);
    if (!account.verified) throw creditError("Sign in to use a NATION wallet.", 403);

    if (path === "/api/credits/wallet/embedded" && method === "POST") {
      const input = createSchema.parse(await readBody(req));
      const existing = wallet();
      if (existing) return json(res, 200, { wallet: { address: getAddress(existing.address), credentialId: existing.credential_id } });
      let created: Awaited<ReturnType<TurnkeyClient["createWallet"]>>;
      try {
        created = await client.createWallet({
          // An opaque name: the wallet service never learns who this is.
          name: `nation-${createHash("sha256").update(account.id).digest("hex").slice(0, 24)}`,
          challenge: input.challenge,
          attestation: input.attestation,
        });
      } catch (error) {
        log(`NATION wallet: creating a wallet failed: ${error instanceof Error ? error.message : String(error)}`);
        throw creditError("Your NATION wallet could not be created. Try again in a minute.", error instanceof TurnkeyError && error.status === 400 ? 400 : 502);
      }
      ledger.db.prepare("INSERT INTO credit_embedded_wallets VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO NOTHING")
        .run(account.id, created.subOrganizationId, created.walletId, created.address.toLowerCase(), input.attestation.credentialId, Date.now());
      const row = wallet()!;
      return json(res, 201, { wallet: { address: getAddress(row.address), credentialId: row.credential_id } });
    }

    const open = (invoiceId: string): { invoice: CreditInvoice; chain: CreditChain; row: WalletRow } => {
      const invoice = ledger.invoice(invoiceId);
      if (!invoice || invoice.user_id !== account.id) throw creditError("Payment request not found", 404);
      if (invoice.paid_tx) throw creditError("This payment request is already paid.", 409);
      if (invoice.expires_at <= Date.now()) throw creditError("This payment request has expired. Choose a pack to start a new one.", 409);
      const chain = chains.find((item) => item.id === invoice.chain && item.token === invoice.token.toLowerCase());
      if (!chain) throw creditError("This payment request is for a network or token that is no longer offered.", 409);
      const row = wallet();
      if (!row) throw creditError("Create your NATION wallet first.", 404);
      return { invoice, chain, row };
    };

    if (path === "/api/credits/wallet/embedded/prepare" && method === "POST") {
      const { invoiceId } = prepareSchema.parse(await readBody(req));
      const { invoice, chain, row } = open(invoiceId);
      const rpc = chainClient(chain);
      if (await rpc.getChainId() !== chain.id) throw creditError("Payment network is unavailable.", 503);
      const from = getAddress(row.address);
      const transfer = invoiceTransfer(invoice);
      const [held, eth, nonce, fees] = await Promise.all([
        rpc.readContract({ address: transfer.to, abi: ERC20, functionName: "balanceOf", args: [from] }),
        rpc.getBalance({ address: from }),
        rpc.getTransactionCount({ address: from, blockTag: "pending" }),
        rpc.estimateFeesPerGas(),
      ]);
      if (held < transfer.units) {
        throw creditError(`Your NATION wallet holds ${formatUnits(held, chain.decimals)} ${chain.symbol}; this payment needs ${formatUnits(transfer.units, chain.decimals)} ${chain.symbol}. Add ${chain.symbol} to ${from} on ${chain.name}, then pay.`, 409);
      }
      const gas = (await rpc.estimateGas({ account: from, to: transfer.to, data: transfer.data }) * 12n) / 10n;
      if (eth < gas * fees.maxFeePerGas) {
        throw creditError(`Your NATION wallet needs a little ETH on ${chain.name} for the network fee (about ${formatUnits(gas * fees.maxFeePerGas, 18)} ETH). Add it to ${from}, then pay.`, 409);
      }
      const unsigned = serializeTransaction({
        type: "eip1559", chainId: chain.id, nonce, gas, to: transfer.to, value: 0n, data: transfer.data,
        maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });
      const body = JSON.stringify({
        type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
        timestampMs: String(Date.now()),
        organizationId: row.sub_org_id,
        parameters: { signWith: from, type: "TRANSACTION_TYPE_ETHEREUM", unsignedTransaction: unsigned.slice(2) },
      });
      return json(res, 200, { body, credentialId: row.credential_id, amount: formatUnits(transfer.units, chain.decimals), symbol: chain.symbol });
    }

    if (path === "/api/credits/wallet/embedded/pay" && method === "POST") {
      const input = paySchema.parse(await readBody(req));
      const { invoice, chain, row } = open(input.invoiceId);
      let request: { type?: unknown; timestampMs?: unknown; organizationId?: unknown; parameters?: { signWith?: unknown; type?: unknown; unsignedTransaction?: unknown } };
      try { request = JSON.parse(input.body); } catch { throw creditError("That payment approval is not valid. Start the payment again."); }
      const age = Math.abs(Date.now() - Number(request.timestampMs));
      if (
        request.type !== "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" || request.organizationId !== row.sub_org_id || !(age < SIGN_WINDOW_MS)
        || typeof request.parameters?.signWith !== "string" || request.parameters.signWith.toLowerCase() !== row.address
        || request.parameters.type !== "TRANSACTION_TYPE_ETHEREUM" || typeof request.parameters.unsignedTransaction !== "string"
        || !/^[0-9a-fA-F]+$/.test(request.parameters.unsignedTransaction)
        || !paysInvoice(`0x${request.parameters.unsignedTransaction}`, invoice)
      ) {
        throw creditError("That payment approval is not for this payment request. Start the payment again.");
      }
      let stamp: z.infer<typeof stampSchema>;
      try { stamp = stampSchema.parse(JSON.parse(input.stamp)); } catch { throw creditError("The passkey approval is not valid. Try again."); }
      if (!stampMatchesBody(stamp, input.body)) throw creditError("The passkey approval does not match this payment. Try again.");
      if (paying.has(account.id)) throw creditError("A payment from your NATION wallet is already being sent.", 409);
      paying.add(account.id);
      try {
        let signed: Hex;
        try {
          signed = await client.signWithPasskey(input.body, input.stamp, row.sub_org_id) as Hex;
        } catch (error) {
          log(`NATION wallet: signing for invoice ${invoice.id} failed: ${error instanceof Error ? error.message : String(error)}`);
          throw creditError("Your passkey approval was not accepted. Try again.", error instanceof TurnkeyError && error.status === 400 ? 400 : 502);
        }
        const signer = await recoverTransactionAddress({ serializedTransaction: signed as Parameters<typeof recoverTransactionAddress>[0]["serializedTransaction"] }).catch(() => null);
        if (!paysInvoice(signed, invoice) || signer?.toLowerCase() !== row.address) {
          log(`NATION wallet: the signed transaction for invoice ${invoice.id} did not match it; nothing was sent`);
          throw creditError("The signed payment did not match this payment request; nothing was sent.", 502);
        }
        let txHash: Hex;
        try {
          txHash = await chainClient(chain).sendRawTransaction({ serializedTransaction: signed as Parameters<ReturnType<typeof chainClient>["sendRawTransaction"]>[0]["serializedTransaction"] });
        } catch (error) {
          log(`NATION wallet: broadcasting the payment for invoice ${invoice.id} failed: ${error instanceof Error ? error.message : String(error)}`);
          throw creditError(`${chain.name} did not accept the payment. Check your wallet balance and try again.`, 502);
        }
        log(`NATION wallet: payment for invoice ${invoice.id} sent in ${txHash}`);
        return json(res, 200, { txHash });
      } finally {
        paying.delete(account.id);
      }
    }
    return json(res, 404, { error: "Not found" });
  };
}

/** What the wallet holds of each payment token, and ETH for fees, as whole-unit strings. */
async function balances(address: string, chains: CreditChain[]): Promise<{ tokens: Array<{ symbol: string; token: string; amount: string }>; eth: string } | null> {
  try {
    const owner = getAddress(address);
    const rpc = chainClient(chains[0]!);
    const [eth, ...held] = await Promise.all([
      rpc.getBalance({ address: owner }),
      ...chains.map((chain) => rpc.readContract({ address: getAddress(chain.token), abi: ERC20, functionName: "balanceOf", args: [owner] })),
    ]);
    return {
      eth: formatUnits(eth as bigint, 18),
      tokens: chains.map((chain, index) => ({ symbol: chain.symbol, token: getAddress(chain.token), amount: formatUnits(held[index] as bigint, chain.decimals) })),
    };
  } catch {
    return null;
  }
}
