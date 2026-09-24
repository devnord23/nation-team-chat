import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
const field = "w-full rounded-xl border border-hairline/50 bg-inset p-3 text-ink";
const button = "rounded-xl bg-accent px-4 py-2 font-medium text-accent-ink disabled:opacity-50";

export function NationCreditAdmin() {
  const [data, setData] = useState<{ users: Record<string, unknown>[]; ledger: Record<string, unknown>[]; payments: Record<string, unknown>[]; daily: Record<string, unknown>[]; pendingCosts: Record<string, unknown>[] } | null>(null);
  const [userId, setUserId] = useState(""), [amount, setAmount] = useState(""), [reason, setReason] = useState(""), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [callId, setCallId] = useState(""), [actualCost, setActualCost] = useState("");
  const refresh = useCallback(async () => { setData(await api("/api/admin/credits")); }, []);
  useEffect(() => { void refresh().catch(error => setError(String(error))); }, [refresh]);
  const adjust = async () => {
    setBusy(true); setError("");
    try { await api("/api/admin/credits/adjust", { method: "POST", body: JSON.stringify({ userId, amountUsd: Number(amount), reason }) }); setAmount(""); setReason(""); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Adjustment failed"); }
    finally { setBusy(false); }
  };
  const reconcile = async () => {
    setBusy(true); setError("");
    try { await api("/api/admin/credits/reconcile", { method: "POST", body: JSON.stringify({ callId, actualCostUsd: Number(actualCost), reason }) }); setActualCost(""); setCallId(""); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Reconciliation failed"); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 text-ink">
    <h2 className="text-lg font-semibold">Credits and payments</h2>
    <p className="text-sm text-ink-secondary">Daily actual OpenRouter cost versus credit sold. Account identifiers are private ledger IDs.</p>
    <label className="block">Account<select className={field} value={userId} onChange={event => setUserId(event.target.value)}><option value="">Choose an account</option>{data?.users.map(user => <option key={String(user.id)} value={String(user.id)}>{String(user.id)} · ${(Number(user.balance_micros) / 1e6).toFixed(2)}</option>)}</select></label>
    <label className="block">USD to add or remove<input className={field} type="number" step="0.000001" value={amount} onChange={event => setAmount(event.target.value)} /></label>
    <label className="block">Reason<input className={field} value={reason} onChange={event => setReason(event.target.value)} maxLength={500} /></label>
    <button className={button} disabled={busy || !userId || !Number(amount) || !reason.trim()} onClick={() => void adjust()}>Record adjustment</button>
    {!!data?.pendingCosts.length && <fieldset className="space-y-3 rounded-xl border border-hairline p-4">
      <legend>Reconcile an interrupted model call</legend>
      <p className="text-sm">Look up the actual provider cost first. Enter zero only after confirming the request was never billed. The reason is recorded in the usage ledger.</p>
      <select className={field} aria-label="Pending call" value={callId} onChange={event => setCallId(event.target.value)}><option value="">Choose a call</option>{data.pendingCosts.map(call => <option key={String(call.id)} value={String(call.id)}>{String(call.id)} · {String(call.provider_id ?? "No provider receipt")}</option>)}</select>
      <input className={field} aria-label="Actual provider cost in USD" type="number" min="0" step="0.000001" value={actualCost} onChange={event => setActualCost(event.target.value)} />
      <button className={button} disabled={busy || !callId || actualCost === "" || Number(actualCost) < 0 || !reason.trim()} onClick={() => void reconcile()}>Record confirmed cost</button>
    </fieldset>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    {data && <>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th>Day</th><th>Provider cost</th><th>Credit sold</th></tr></thead><tbody>{data.daily.map(day => <tr key={String(day.day)}><td>{String(day.day)}</td><td>${(Number(day.cost_micros) / 1e6).toFixed(6)}</td><td>${(Number(day.sold_micros) / 1e6).toFixed(6)}</td></tr>)}</tbody></table></div>
      {(["users", "ledger", "payments", "pendingCosts"] as const).map(key => <details key={key} className="rounded-xl bg-inset p-3"><summary>{key} ({data[key].length})</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre text-xs">{JSON.stringify(data[key], null, 2)}</pre></details>)}
    </>}
  </section>;
}
