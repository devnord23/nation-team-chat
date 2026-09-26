// A loopback stand-in for the Turnkey API for NATION wallet tests and
// fixtures. It checks what the real service checks for our purposes: the
// API key stamp on sub-organization requests (a P-256 signature over the
// exact body, from the configured key), and that a sign request carries a
// passkey stamp from that wallet's own passkey whose challenge is
// hex(sha256(body)). It then signs with a local key per wallet, the way
// Turnkey's enclave would.
import { createECDH, createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, parseTransaction, type Hex } from "viem";

export interface FakeTurnkey {
  url: string;
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  wallets: Map<string, { account: PrivateKeyAccount; credentialId: string }>;
  requests: Array<{ path: string; body: any; stamp: "api-key" | "passkey" | "none" | "bad" }>;
  /** "evil": sign a transfer to someone else instead; "pending": finish only when polled. */
  mode: { evil?: boolean; pending?: boolean; refuseSign?: boolean };
  close(): Promise<void>;
}

const b64urlJson = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

export async function startFakeTurnkey(): Promise<FakeTurnkey> {
  // A fresh parent-organization API key, in Turnkey's hex formats.
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }) as { d: string };
  const apiPrivateKey = Buffer.from(jwk.d, "base64url").toString("hex");
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(apiPrivateKey, "hex"));
  const apiPublicKey = ecdh.getPublicKey("hex", "compressed");
  const uncompressed = ecdh.getPublicKey();
  const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: uncompressed.subarray(1, 33).toString("base64url"), y: uncompressed.subarray(33).toString("base64url") }, format: "jwk" });
  const organizationId = randomUUID();
  const wallets = new Map<string, { account: PrivateKeyAccount; credentialId: string }>();
  const activities = new Map<string, unknown>();
  const requests: FakeTurnkey["requests"] = [];
  const mode: FakeTurnkey["mode"] = {};

  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    let body: any;
    try { body = JSON.parse(raw); } catch { return send(400, { message: "invalid json" }); }
    const apiStamp = req.headers["x-stamp"];
    const passkeyStamp = req.headers["x-stamp-webauthn"];
    const apiKeyValid = () => {
      try {
        const stamp = b64urlJson(String(apiStamp));
        return stamp.scheme === "SIGNATURE_SCHEME_TK_API_P256" && stamp.publicKey === apiPublicKey
          && verify("sha256", Buffer.from(raw), publicKey, Buffer.from(stamp.signature, "hex"));
      } catch { return false; }
    };
    const finish = (activity: { id: string; status: string; result?: unknown }) => {
      activities.set(activity.id, { ...activity, status: "ACTIVITY_STATUS_COMPLETED" });
      return send(200, { activity: mode.pending ? { id: activity.id, status: "ACTIVITY_STATUS_PENDING" } : activity });
    };

    if (req.url === "/public/v1/submit/create_sub_organization") {
      const valid = apiKeyValid();
      requests.push({ path: req.url, body, stamp: valid ? "api-key" : "bad" });
      if (!valid) return send(401, { message: "invalid stamp" });
      const authenticator = body?.parameters?.rootUsers?.[0]?.authenticators?.[0];
      if (body.type !== "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8" || body.organizationId !== organizationId || !authenticator?.attestation?.credentialId || !authenticator.challenge) {
        return send(400, { message: "invalid create_sub_organization request" });
      }
      const subOrganizationId = randomUUID();
      const account = privateKeyToAccount(generatePrivateKey());
      wallets.set(subOrganizationId, { account, credentialId: authenticator.attestation.credentialId });
      return finish({ id: randomUUID(), status: "ACTIVITY_STATUS_COMPLETED", result: {
        createSubOrganizationResultV8: { subOrganizationId, wallet: { walletId: randomUUID(), addresses: [account.address] }, rootUserIds: [randomUUID()] },
      } });
    }

    if (req.url === "/public/v1/submit/sign_transaction") {
      let stamp: any = null;
      try { stamp = JSON.parse(String(passkeyStamp)); } catch { /* none */ }
      const wallet = wallets.get(body?.organizationId);
      const challenge = Buffer.from(createHash("sha256").update(raw).digest("hex"), "utf8").toString("base64url");
      let client: any = null;
      try { client = b64urlJson(stamp?.clientDataJson ?? ""); } catch { /* invalid */ }
      const valid = Boolean(wallet && stamp && stamp.credentialId === wallet.credentialId && client?.type === "webauthn.get" && client.challenge === challenge);
      requests.push({ path: req.url, body, stamp: passkeyStamp ? (valid ? "passkey" : "bad") : "none" });
      if (!valid || !wallet) return send(401, { message: "invalid passkey stamp" });
      if (mode.refuseSign) return send(400, { message: "policy denied" });
      if (body.type !== "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" || body.parameters?.signWith?.toLowerCase() !== wallet.account.address.toLowerCase()) {
        return send(400, { message: "invalid sign_transaction request" });
      }
      const tx = parseTransaction(`0x${body.parameters.unsignedTransaction}` as Hex);
      const payload = mode.evil
        ? { ...tx, data: encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: ["0x000000000000000000000000000000000000dEaD", 1n] }) }
        : tx;
      const signed = await wallet.account.signTransaction(payload as never);
      return finish({ id: randomUUID(), status: "ACTIVITY_STATUS_COMPLETED", result: { signTransactionResult: { signedTransaction: signed.slice(2) } } });
    }

    if (req.url === "/public/v1/query/get_activity") {
      requests.push({ path: req.url, body, stamp: apiKeyValid() ? "api-key" : "bad" });
      const activity = activities.get(body?.activityId);
      return activity ? send(200, { activity }) : send(404, { message: "no such activity" });
    }
    send(404, { message: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    organizationId, apiPublicKey, apiPrivateKey, wallets, requests, mode,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
