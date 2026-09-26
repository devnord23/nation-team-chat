// Passkeys for the NATION wallet (server/routes/nation-wallet.ts): create
// one for a new wallet, and approve a wallet request with it. The wallet is
// held by this passkey alone; Nation Team Chat cannot move its funds.
//
// The formats are the wallet service's own: an attestation of rawId,
// clientDataJSON and attestationObject, base64url; and an approval whose
// WebAuthn challenge is the UTF-8 text of hex(sha256(request body)).

export interface WalletAttestation {
  challenge: string;
  attestation: { credentialId: string; clientDataJson: string; attestationObject: string; transports: string[] };
}

const TRANSPORTS: Record<string, string> = {
  internal: "AUTHENTICATOR_TRANSPORT_INTERNAL",
  usb: "AUTHENTICATOR_TRANSPORT_USB",
  nfc: "AUTHENTICATOR_TRANSPORT_NFC",
  ble: "AUTHENTICATOR_TRANSPORT_BLE",
  hybrid: "AUTHENTICATOR_TRANSPORT_HYBRID",
};

export function base64url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The WebAuthn challenge for a wallet request body. */
export async function approvalChallenge(body: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return new TextEncoder().encode(hex);
}

/** Passkeys need a secure page on a named host (not a bare IP address). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && Boolean(navigator.credentials)
    && window.isSecureContext !== false && !/^\d+\.\d+\.\d+\.\d+$|:/.test(location.hostname);
}

/** A new passkey for this site, ready to create a wallet with. */
export async function createWalletPasskey(): Promise<WalletAttestation> {
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { id: location.hostname, name: "Nation Team Chat" },
      user: { id: crypto.getRandomValues(new Uint8Array(32)), name: "NATION wallet", displayName: "NATION wallet" },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      attestation: "none",
      timeout: 300_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
  return {
    challenge: base64url(challenge),
    attestation: {
      credentialId: base64url(credential.rawId),
      clientDataJson: base64url(response.clientDataJSON),
      attestationObject: base64url(response.attestationObject),
      transports: transports.map((transport) => TRANSPORTS[transport]).filter((value): value is string => Boolean(value)),
    },
  };
}

/** Approve one wallet request with the wallet's passkey; returns the stamp to send with it. */
export async function approveWithPasskey(body: string, credentialId: string): Promise<string> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      rpId: location.hostname,
      challenge: await approvalChallenge(body),
      allowCredentials: [{ type: "public-key", id: fromBase64url(credentialId) }],
      userVerification: "preferred",
      timeout: 300_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("The passkey did not approve the payment.");
  const response = credential.response as AuthenticatorAssertionResponse;
  return JSON.stringify({
    authenticatorData: base64url(response.authenticatorData),
    clientDataJson: base64url(response.clientDataJSON),
    credentialId: base64url(credential.rawId),
    signature: base64url(response.signature),
  });
}
