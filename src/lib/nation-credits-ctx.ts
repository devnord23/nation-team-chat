/**
 * Lightweight React context that lets any component open the Nation credit
 * sheet and read the latest credit status without prop-drilling through the
 * whole component tree. NationCredits provides the value; SidebarProfileMenu
 * and any other consumer reads it.
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
  chains: Array<{ id: number; name: string; symbol: string; token: string; treasury: string; decimals: number }>;
  invoices: Array<{ id: string; chain: number; treasury: string; token: string; pack_micros: number; amount_micros: number; token_amount: string; expires_at: number; paid_tx: string | null }>;
};

export interface NationCreditsCtxValue {
  status: CreditStatus | null;
  open: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  openSubscription: () => void;
}

export const NationCreditsCtx = createContext<NationCreditsCtxValue>({
  status: null,
  open: false,
  openSheet: () => {},
  closeSheet: () => {},
  openSubscription: () => {},
});

export function useNationCredits() {
  return useContext(NationCreditsCtx);
}
