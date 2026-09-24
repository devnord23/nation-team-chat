/**
 * Nation crypto plan catalog and chain configuration.
 *
 * VERIFIED on-chain (2026-09-24):
 *   USDG on Robinhood Chain: symbol=USDG, decimals=6
 *   Robinhood Chain mainnet chainId: 0x1237 = 4663
 *
 * UNVERIFIED:
 *   Robinhood Chain testnet — no public testnet found in docs. The testnet
 *   flag for Robinhood Chain is disabled (see TESTNET_CHAINS below). If a
 *   testnet is announced, add chainId + RPC here and flip enabled.
 *
 * Env vars the founder MUST set before payments go live:
 *
 *   NATION_TREASURY_BASE=0x…          Treasury wallet on Base (receives USDC)
 *   NATION_TREASURY_ROBINHOOD=0x…     Treasury wallet on Robinhood Chain (receives USDG)
 *
 * If a treasury address is unset, the corresponding payment option is hidden
 * from users (no error, no setup screen shown).
 *
 * Plan prices come from env vars (see planCatalog()). Placeholder defaults
 * are clearly marked — founder sets final prices before going live.
 *
 * Testnet flag:
 *   NATION_BILLING_TESTNET=1           Use testnets (Base Sepolia). For development only.
 *
 * RPC overrides (optional; public fallbacks are provided):
 *   NATION_RPC_BASE=https://…          RPC for Base mainnet
 *   NATION_RPC_BASE_SEPOLIA=https://…  RPC for Base Sepolia
 *   NATION_RPC_ROBINHOOD=https://…     RPC for Robinhood Chain mainnet
 *
 * Confirmations threshold:
 *   NATION_CONFIRMATIONS=3             Blocks to wait before crediting (default: 3)
 */

// ── Plan catalog ─────────────────────────────────────────────────────────────

export interface NationPlan {
  id: string;
  label: string;
  /** List price in USD cents (integer). Env override: NATION_PLAN_<ID>_USD_CENTS */
  usdCents: number;
  /** Credits granted on purchase. Env override: NATION_PLAN_<ID>_CREDITS */
  credits: number;
  /** Entitlement duration in seconds (30 days = 2_592_000). */
  intervalSeconds: number;
}

/** PLACEHOLDER DEFAULTS — founder must set final prices via env vars. */
const PLAN_DEFAULTS: NationPlan[] = [
  { id: "starter", label: "Starter", usdCents: 1500, credits: 500, intervalSeconds: 30 * 24 * 3600 },
  { id: "pro", label: "Pro", usdCents: 4900, credits: 2000, intervalSeconds: 30 * 24 * 3600 },
  { id: "max", label: "Max", usdCents: 9900, credits: 5000, intervalSeconds: 30 * 24 * 3600 },
];

export function planCatalog(env: NodeJS.ProcessEnv = process.env): NationPlan[] {
  return PLAN_DEFAULTS.map((plan) => {
    const idUpper = plan.id.toUpperCase();
    const centsEnv = env[`NATION_PLAN_${idUpper}_USD_CENTS`];
    const creditsEnv = env[`NATION_PLAN_${idUpper}_CREDITS`];
    const cents = centsEnv ? parseInt(centsEnv, 10) : plan.usdCents;
    const credits = creditsEnv ? parseInt(creditsEnv, 10) : plan.credits;
    return {
      ...plan,
      usdCents: Number.isFinite(cents) && cents > 0 ? cents : plan.usdCents,
      credits: Number.isFinite(credits) && credits > 0 ? credits : plan.credits,
    };
  });
}

export function planById(id: string, env?: NodeJS.ProcessEnv): NationPlan | undefined {
  return planCatalog(env).find((p) => p.id === id);
}

// ── Chain + token configuration ───────────────────────────────────────────────

export interface ChainConfig {
  chainId: number;
  label: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAddress: `0x${string}`;
  /** ERC-20 Transfer event topic0 (standard, unparameterized). */
  transferTopic: `0x${string}`;
  rpcUrl: string;
  treasuryEnvKey: string;
  /** Block explorer TX URL prefix (append tx hash). */
  explorerTxUrl: string;
  isTestnet: boolean;
}

const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

/** Returns the chains available to offer payment on, based on treasury configuration.
 * If NATION_BILLING_TESTNET=1, mainnet chains are replaced by their testnets. */
export function availableChains(env: NodeJS.ProcessEnv = process.env): ChainConfig[] {
  const testnet = (env.NATION_BILLING_TESTNET ?? "").trim() === "1";
  const chains: ChainConfig[] = testnet ? TESTNET_CHAINS : MAINNET_CHAINS;
  return chains.filter((c) => {
    const treasury = (env[c.treasuryEnvKey] ?? "").trim();
    return isAddress(treasury);
  });
}

export function chainById(chainId: number, env?: NodeJS.ProcessEnv): ChainConfig | undefined {
  const env_ = env ?? process.env;
  const testnet = (env_.NATION_BILLING_TESTNET ?? "").trim() === "1";
  const all = [...MAINNET_CHAINS, ...TESTNET_CHAINS];
  return all.find((c) => c.chainId === chainId && c.isTestnet === testnet);
}

export function allKnownChains(): ChainConfig[] {
  return [...MAINNET_CHAINS, ...TESTNET_CHAINS];
}

function isAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function treasuryAddress(chain: ChainConfig, env: NodeJS.ProcessEnv = process.env): `0x${string}` | null {
  const addr = (env[chain.treasuryEnvKey] ?? "").trim();
  return isAddress(addr) ? (addr as `0x${string}`) : null;
}

const MAINNET_CHAINS: ChainConfig[] = [
  {
    chainId: 8453,
    label: "Base",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    transferTopic: ERC20_TRANSFER_TOPIC,
    rpcUrl: "https://mainnet.base.org",
    treasuryEnvKey: "NATION_TREASURY_BASE",
    explorerTxUrl: "https://basescan.org/tx/",
    isTestnet: false,
  },
  {
    chainId: 4663,
    label: "Robinhood Chain",
    tokenSymbol: "USDG",
    tokenDecimals: 6, // verified on-chain: 0x06 = 6
    tokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    transferTopic: ERC20_TRANSFER_TOPIC,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    treasuryEnvKey: "NATION_TREASURY_ROBINHOOD",
    explorerTxUrl: "https://explorer.chain.robinhood.com/tx/",
    isTestnet: false,
  },
];

const TESTNET_CHAINS: ChainConfig[] = [
  {
    chainId: 84532,
    label: "Base Sepolia (testnet)",
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    // Circle testnet USDC on Base Sepolia
    tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    transferTopic: ERC20_TRANSFER_TOPIC,
    rpcUrl: "https://sepolia.base.org",
    treasuryEnvKey: "NATION_TREASURY_BASE",
    explorerTxUrl: "https://sepolia.basescan.org/tx/",
    isTestnet: true,
  },
  // NOTE: No public Robinhood Chain testnet was found in their documentation
  // (https://docs.robinhood.com/chain/networks/). If one is announced, add it
  // here and flip the enabled flag. Until then, RH Chain cannot be tested
  // end-to-end without real money. [UNVERIFIED]
];

// ── Amount suffixing for idempotent quote matching ────────────────────────────
//
// Why unique-amount suffixing:
//   Two users paying the same plan at the same time would produce identical
//   (receiver, amount) pairs, making matching ambiguous. We append a small
//   random dust suffix (0–99 base units, i.e. 0–99 micro-USD for a 6-decimal
//   token) to each quote's expected amount. This makes every quote amount
//   unique with high probability while being invisible (< $0.0001 difference).
//
//   Trade-off considered: a canonical memo field (like a tx `data` field) would
//   be cleaner, but ERC-20 `transfer` does not carry a memo, and requiring
//   users to encode a reference into calldata (via a wallet that supports it)
//   adds UX friction. Unique amounts are how Dot does it in practice.

/** Dust range: 0–99 extra base units appended to the plan price. */
export const AMOUNT_SUFFIX_RANGE = 100;

/** Generate the exact expected amount for a quote (plan price + dust suffix).
 * @param usdCents Plan price in USD cents
 * @param tokenDecimals Token decimal places
 * @param dustSuffix Random 0–(AMOUNT_SUFFIX_RANGE-1) base-unit suffix
 */
export function quoteAmountBaseUnits(
  usdCents: number,
  tokenDecimals: number,
  dustSuffix: number,
): bigint {
  // Convert cents → token base units: (usdCents / 100) * 10^decimals
  const priceBaseUnits = BigInt(usdCents) * BigInt(10 ** tokenDecimals) / 100n;
  return priceBaseUnits + BigInt(dustSuffix);
}

export const QUOTE_TTL_SECONDS = 30 * 60; // 30 minutes, matching Dot's topup TTL
export const REQUIRED_CONFIRMATIONS_DEFAULT = 3;

export function requiredConfirmations(env: NodeJS.ProcessEnv = process.env): number {
  const val = parseInt(env.NATION_CONFIRMATIONS ?? "", 10);
  return Number.isFinite(val) && val >= 1 ? val : REQUIRED_CONFIRMATIONS_DEFAULT;
}

export function rpcUrlForChain(chain: ChainConfig, env: NodeJS.ProcessEnv = process.env): string {
  const envKey = chain.chainId === 8453
    ? "NATION_RPC_BASE"
    : chain.chainId === 84532
      ? "NATION_RPC_BASE_SEPOLIA"
      : chain.chainId === 4663
        ? "NATION_RPC_ROBINHOOD"
        : undefined;
  if (envKey) {
    const override = (env[envKey] ?? "").trim();
    if (override) return override;
  }
  return chain.rpcUrl;
}
