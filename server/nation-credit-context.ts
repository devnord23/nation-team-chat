import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { CreditLedger, creditError, type CreditAccount } from "./nation-credits.ts";
import { nationDataDir } from "./nation-compat.ts";
import type { RequestAuth } from "./request-auth.ts";

export const creditContext = new AsyncLocalStorage<CreditAccount | null>();
let ledger: CreditLedger | undefined;
export function nationLedger(): CreditLedger { return ledger ??= new CreditLedger(join(nationDataDir(), "nation-credits.db")); }
export function setCreditLedgerForTests(value?: CreditLedger) { ledger = value; }
export function creditAccount(auth: RequestAuth): CreditAccount {
  const operator = auth.scopes.includes("admin") && (process.env.NATION_PRODUCT_OWNER === "1" || process.env.NATION_PRODUCT_ADMIN === "1");
  if (operator) return { id: "nation-operator", verified: true, exempt: true };
  if (auth.kind === "session" && auth.session.email && auth.session.userId) {
    const email = auth.session.email.trim().toLowerCase();
    return { id: "email:" + createHash("sha256").update(email).digest("hex"), email, verified: true };
  }
  if (auth.kind === "session") {
    const wallet = nationLedger().db.prepare("SELECT address FROM credit_wallets WHERE session_id=?").get(auth.session.id);
    if (wallet) return { id: "wallet:" + wallet.address, verified: true };
  }
  return { id: auth.kind === "session" ? "session:" + auth.session.id : "local-unverified", verified: false };
}
export function creditsEnforced(): boolean { return Boolean(process.env.OPENROUTER_API_KEY); }
export function requireCreditAccount(): CreditAccount {
  const account = creditContext.getStore();
  if (!account) throw creditError("Sign in to use your NATION credit.", 403);
  return account;
}
/** The account a thread's turns run for (its credit sponsor), if recorded. */
export function threadSponsorId(threadId: string): string | undefined {
  if (!creditsEnforced()) return undefined;
  const row = nationLedger().db.prepare("SELECT user_id FROM credit_sponsors WHERE thread_id=?").get(threadId);
  return row ? String(row.user_id) : undefined;
}
/** Persist the sponsor of a thread so continuations cannot become free anonymous calls. */
export function sponsorCreditThread(threadId: string): CreditAccount | undefined {
  if (!creditsEnforced()) return undefined;
  const current = creditContext.getStore();
  if (current) {
    nationLedger().account(current);
    nationLedger().db.prepare("INSERT INTO credit_sponsors VALUES(?,?) ON CONFLICT(thread_id) DO UPDATE SET user_id=excluded.user_id").run(threadId, current.id);
    return current;
  }
  const saved = nationLedger().db.prepare("SELECT a.* FROM credit_sponsors s JOIN credit_accounts a ON a.id=s.user_id WHERE s.thread_id=?").get(threadId);
  if (!saved) throw creditError("Open this conversation to resume using your NATION credit.", 403);
  const account = { id: String(saved.id), verified: Boolean(saved.verified), exempt: Boolean(saved.exempt) && (process.env.NATION_PRODUCT_OWNER === "1" || process.env.NATION_PRODUCT_ADMIN === "1") };
  creditContext.enterWith(account);
  return account;
}
