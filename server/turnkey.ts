// The NATION wallet: a Turnkey embedded wallet per account, held by the
// person's own passkey. NATION's Turnkey organization creates one
// sub-organization per account whose only root credential is that passkey,
// so this server can create a wallet but never move its funds: every
// payment is a request the person's passkey stamps in their browser.
//
//   TURNKEY_ORGANIZATION_ID   NATION's parent organization id
//   TURNKEY_API_PUBLIC_KEY    its API key, compressed P-256 public key (hex)
//   TURNKEY_API_PRIVATE_KEY   the matching private key (hex); server only
//   TURNKEY_API_BASE_URL      optional, defaults to https://api.turnkey.com
//
// The API key stamp is Turnkey's documented scheme (X-Stamp: base64url of
// {publicKey, scheme: SIGNATURE_SCHEME_TK_API_P256, signature}), where the
// signature is DER-encoded ECDSA P-256 over SHA-256 of the exact body.
import { createECDH, createPrivateKey, createSign } from "node:crypto";

export interface TurnkeyConfig {
  baseUrl: string;
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
}

/** Null unless all three credentials look right; a half-configured wallet is off. */
export function turnkeyConfig(env: NodeJS.ProcessEnv = process.env): TurnkeyConfig | null {
  const organizationId = env.TURNKEY_ORGANIZATION_ID?.trim() ?? "";
  const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY?.trim().toLowerCase() ?? "";
  const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY?.trim().toLowerCase() ?? "";
  const baseUrl = (env.TURNKEY_API_BASE_URL?.trim() || "https://api.turnkey.com").replace(/\/+$/, "");
  if (!/^[0-9a-f-]{8,64}$/i.test(organizationId) || !/^0[23][0-9a-f]{64}$/.test(apiPublicKey) || !/^[0-9a-f]{64}$/.test(apiPrivateKey)) return null;
  if (!baseUrl.startsWith("https://") && !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) return null;
  return { baseUrl, organizationId, apiPublicKey, apiPrivateKey };
}

const base64url = (value: Buffer) => value.toString("base64url");

/** The X-Stamp header value for a request body. */
export function apiKeyStamp(body: string, publicKeyHex: string, privateKeyHex: string): string {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"));
  const point = ecdh.getPublicKey();
  const derived = ecdh.getPublicKey("hex", "compressed");
  if (derived !== publicKeyHex.toLowerCase()) throw new Error("TURNKEY_API_PUBLIC_KEY does not match TURNKEY_API_PRIVATE_KEY");
  const key = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: base64url(Buffer.from(privateKeyHex, "hex")), x: base64url(point.subarray(1, 33)), y: base64url(point.subarray(33, 65)) },
    format: "jwk",
  });
  const signature = createSign("SHA256").update(body).sign(key).toString("hex");
  return Buffer.from(JSON.stringify({ publicKey: publicKeyHex, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature })).toString("base64url");
}

export interface PasskeyAttestation {
  credentialId: string;
  clientDataJson: string;
  attestationObject: string;
  transports: string[];
}

export class TurnkeyError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

interface Activity {
  id?: string;
  status?: string;
  result?: Record<string, { subOrganizationId?: string; wallet?: { walletId?: string; addresses?: string[] }; signedTransaction?: string } | undefined>;
}

export class TurnkeyClient {
  private readonly config: TurnkeyConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: TurnkeyConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  get organizationId(): string {
    return this.config.organizationId;
  }

  private async post(path: string, body: string, stamp: { name: string; value: string }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", [stamp.name]: stamp.value },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new TurnkeyError(`wallet service unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      const message = (parsed as { message?: unknown } | null)?.message;
      throw new TurnkeyError(`wallet service answered ${response.status}${typeof message === "string" ? `: ${message.slice(0, 200)}` : ""}`, response.status >= 500 ? 502 : 400);
    }
    return parsed;
  }

  private async withApiKey(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify(payload);
    return this.post(path, body, { name: "X-Stamp", value: apiKeyStamp(body, this.config.apiPublicKey, this.config.apiPrivateKey) });
  }

  /** Wait for an activity a stamp submitted, when Turnkey did not finish it inline. */
  private async settle(activity: Activity | undefined, organizationId: string): Promise<Activity> {
    let current = activity;
    for (let attempt = 0; attempt < 10 && current && ["ACTIVITY_STATUS_CREATED", "ACTIVITY_STATUS_PENDING"].includes(String(current.status)); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      const polled = await this.withApiKey("/public/v1/query/get_activity", { organizationId, activityId: current.id });
      current = (polled as { activity?: Activity } | null)?.activity;
    }
    if (current?.status !== "ACTIVITY_STATUS_COMPLETED") {
      throw new TurnkeyError(`wallet request did not complete (${String(current?.status ?? "no activity")})`);
    }
    return current;
  }

  /** A sub-organization whose only root user is this passkey, with one
   * Ethereum account. Turnkey's own email features stay off: the passkey is
   * the one way in. */
  async createWallet(input: { name: string; challenge: string; attestation: PasskeyAttestation }): Promise<{ subOrganizationId: string; walletId: string; address: string }> {
    const response = await this.withApiKey("/public/v1/submit/create_sub_organization", {
      type: "ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8",
      timestampMs: String(Date.now()),
      organizationId: this.config.organizationId,
      parameters: {
        subOrganizationName: input.name,
        rootUsers: [{
          userName: "Nation Team Chat member",
          apiKeys: [],
          authenticators: [{ authenticatorName: "NATION wallet passkey", challenge: input.challenge, attestation: input.attestation }],
          oauthProviders: [],
        }],
        rootQuorumThreshold: 1,
        wallet: {
          walletName: "NATION wallet",
          accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: "m/44'/60'/0'/0/0", addressFormat: "ADDRESS_FORMAT_ETHEREUM" }],
        },
        disableEmailRecovery: true,
        disableEmailAuth: true,
        disableSmsAuth: true,
        disableOtpEmailAuth: true,
      },
    });
    const activity = await this.settle((response as { activity?: Activity } | null)?.activity, this.config.organizationId);
    const result = activity.result?.createSubOrganizationResultV8 ?? activity.result?.createSubOrganizationResultV7;
    const address = result?.wallet?.addresses?.[0];
    if (!result?.subOrganizationId || !result.wallet?.walletId || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new TurnkeyError("wallet service returned no wallet");
    }
    return { subOrganizationId: result.subOrganizationId, walletId: result.wallet.walletId, address };
  }

  /** Submit a sign request the person's passkey already stamped; returns the signed transaction (0x…). */
  async signWithPasskey(body: string, webauthnStamp: string, organizationId: string): Promise<string> {
    const response = await this.post("/public/v1/submit/sign_transaction", body, { name: "X-Stamp-Webauthn", value: webauthnStamp });
    const activity = await this.settle((response as { activity?: Activity } | null)?.activity, organizationId);
    const signed = activity.result?.signTransactionResult?.signedTransaction;
    if (!signed || !/^(0x)?[0-9a-fA-F]+$/.test(signed)) throw new TurnkeyError("wallet service returned no signed transaction");
    return signed.startsWith("0x") ? signed : `0x${signed}`;
  }
}
