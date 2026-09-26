/**
 * Lightweight React context that lets any component reach Full Plans (or the
 * starter-credit sheet) and read the latest credit status without
 * prop-drilling through the whole component tree. NationCreditsProvider wraps
 * the app and provides the value; NationCredits, SidebarProfileMenu and the
 * Settings row read it.
 */
import { createContext, useContext } from "react";

export interface CreditTier { id: string; name: string; usd: number; creditUsd: number; popular: boolean }
export type CreditStatus = {
  balanceUsd: number;
  label: string;
  verified: boolean;
  exempt: boolean;
  lowBalance: boolean;
  topUpEnabled: boolean;
  topUpMessage: string;
  starterMessage: string;
  packs: number[];
  tiers: CreditTier[];
  nationPriceUsd: number | null;
  nationDiscount: number | null;
  /** The discount the server applies to $NATION invoices. Servers that bill $NATION at the full
   * price never send it, so "Save N%" is keyed on this and not on nationDiscount. */
  nationInvoiceDiscount?: number | null;
  chains: Array<{ id: number; name: string; symbol: string; token: string; treasury: string; decimals: number }>;
  /** discount_bps: how much less this invoice asks in $NATION (2000 = 20%); the credit is unchanged. */
  invoices: Array<{ id: string; chain: number; treasury: string; token: string; pack_micros: number; amount_micros: number; token_amount: string; discount_bps?: number; expires_at: number; paid_tx: string | null }>;
  /** Read from the ledger: "paid" once the account has paid for a pack. No subscription exists. */
  plan?: "free" | "paid";
  /** Free and not owner/admin: the Free card carries "Current plan". */
  onFreePlan?: boolean;
  /** The starter credit the ledger granted, or the configured amount a verified account receives. */
  starterCreditUsd?: number;
  starterGranted?: boolean;
};

export interface NationCreditsCtxValue {
  status: CreditStatus | null;
  /** Re-read the status now (after a payment or verification). */
  refresh: () => Promise<void>;
  /** The "Get free starter credit" sheet. Buying credit never uses it. */
  starterOpen: boolean;
  openStarter: () => void;
  closeStarter: () => void;
  /** Navigate to Full Plans (/subscription): every "Top up" / "Add credits" entry. */
  openSubscription: () => void;
}

export const NationCreditsCtx = createContext<NationCreditsCtxValue>({
  status: null,
  refresh: async () => {},
  starterOpen: false,
  openStarter: () => {},
  closeStarter: () => {},
  openSubscription: () => {},
});

export function useNationCredits() {
  return useContext(NationCreditsCtx);
}
