/**
 * Nation Admin Page — accessible only to the account owner (product admin).
 *
 * Consolidates: OpenRouter status, engine settings, connector/API-key settings.
 * Non-admins receive a 403 from every /api/admin/* endpoint and the nav link
 * never renders, so there is no meaningful surface for non-admins to reach.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronLeft, CreditCard, Loader2, PlugZap, RefreshCw, Server, ShieldCheck, Terminal, XCircle } from "lucide-react";
import { api, useStore } from "@/state/store";
import { isProductAdmin } from "@/lib/admin-gate";
import { EnginesSettings } from "./EnginesSettings";
import { ApiKeyRow, OpenAiCompatUrl } from "./ApiKeys";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

// ── OpenRouter section ───────────────────────────────────────────────────────

interface OpenRouterAdminStatus {
  configured: boolean;
  model: string;
  testResult?: { ok: boolean; message: string };
}

function OpenRouterSection() {
  const { state } = useStore();
  const status = state.config?.nationOpenrouter;
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result: OpenRouterAdminStatus = await api("/api/admin/openrouter/test", {
        method: "POST",
        body: "{}",
      });
      setTestResult(result.testResult ?? { ok: false, message: "No result returned" });
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card
      title="OpenRouter"
      subtitle="Nation's upstream AI provider. The API key is server-only and never sent to clients."
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full",
              status?.configured
                ? "bg-success/15 text-success"
                : "bg-warning/15 text-warning",
            )}
          >
            {status?.configured ? (
              <CheckCircle2 size={18} aria-hidden="true" />
            ) : (
              <XCircle size={18} aria-hidden="true" />
            )}
          </span>
          <div>
            <div className="text-[14px] font-medium text-ink">
              {status?.configured
                ? "OPENROUTER_API_KEY is configured"
                : "OPENROUTER_API_KEY is not set"}
            </div>
            {status?.model && (
              <div className="mt-0.5 text-[12px] text-ink-secondary">
                Active model: <code className="rounded bg-inset px-1 py-px text-[11px]">{status.model}</code>
              </div>
            )}
          </div>
        </div>

        {status?.configured && (
          <div>
            <button
              type="button"
              disabled={testing}
              onClick={() => void runTest()}
              className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover disabled:cursor-wait disabled:opacity-50"
            >
              {testing ? <Loader2 size={14} className="animate-spin" /> : <Server size={14} />}
              {testing ? "Testing…" : "Test connection"}
            </button>
            {testResult && (
              <p
                role="status"
                className={cn(
                  "mt-2 text-[12px]",
                  testResult.ok ? "text-success" : "text-danger",
                )}
              >
                {testResult.ok ? "✓ " : "✗ "}
                {testResult.message}
              </p>
            )}
          </div>
        )}

        <div className="border-t border-hairline/30 pt-3">
          <p className="text-[12px] leading-relaxed text-ink-secondary">
            Set <code className="rounded bg-inset px-1 py-px text-[11px]">OPENROUTER_API_KEY</code> and optionally{" "}
            <code className="rounded bg-inset px-1 py-px text-[11px]">NATION_OPENROUTER_MODEL</code> in your server environment.
            The key never leaves the server; clients see only a configured/not-configured boolean.
          </p>
        </div>
      </div>
    </Card>
  );
}

// ── Connections / API keys section ───────────────────────────────────────────

function ConnectionsSection() {
  return (
    <Card
      title="API Keys & Integrations"
      subtitle="Provider credentials stored on the server. Keys are write-only — only configured/not is returned to clients."
    >
      <div className="flex flex-col gap-4">
        <div className="text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
          {t("keys.providers.title")}
        </div>
        <p className="-mt-3 text-[12px] leading-relaxed text-ink-secondary">
          {t("keys.providers.subtitle")}
        </p>
        <ApiKeyRow section="anthropic" testProvider="anthropic" />
        <ApiKeyRow section="openaiCompat" testProvider="openaiCompat" />
        <OpenAiCompatUrl />
        <ApiKeyRow section="xai" testProvider="xai" />
        <div className="pt-2 text-[11.5px] font-medium uppercase tracking-wide text-ink-secondary">
          {t("keys.integrations.title")}
        </div>
        <ApiKeyRow section="box" />
        <ApiKeyRow section="opencodeGo" />
        <details className="rounded-lg border border-hairline/40 bg-inset px-3 py-2">
          <summary className="cursor-pointer text-[13px] text-ink-secondary">
            {t("settings.connections.selfHost")}
          </summary>
          <div className="mt-3">
            <ApiKeyRow section="composio" />
          </div>
        </details>
      </div>
    </Card>
  );
}

// ── Payments admin section ────────────────────────────────────────────────────

interface AdminBillingStatus {
  enabled: boolean;
  testnetMode: boolean;
  chainsAdmin: Array<{
    chainId: number;
    label: string;
    tokenSymbol: string;
    isTestnet: boolean;
    treasuryConfigured: boolean;
  }>;
  plans: Array<{ id: string; label: string; usdCents: number; credits: number }>;
}

interface Quote {
  id: string;
  userId: string;
  planId: string;
  chainId: number;
  amountDisplay: string;
  status: string;
  createdAt: string;
  expiresAt: string;
}

interface Payment {
  id: string;
  userId: string;
  planId: string;
  chainId: number;
  txHash: string;
  tokenSymbol: string;
  confirmedAt: string;
  creditsGranted: number;
  status: string;
}

interface Entitlement {
  userId: string;
  planId: string;
  planLabel: string;
  creditsBalance: number;
  expiresAt: string;
  lastGrantedAt: string;
}

interface WatcherHealth {
  running: boolean;
  chains: Array<{
    chainId: number;
    label: string;
    lastProcessedBlock: number | null;
    lastPollAt: string | null;
    lastError: string | null;
  }>;
}

function PaymentsSection() {
  const [billingStatus, setBillingStatus] = useState<AdminBillingStatus | null>(null);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [entitlements, setEntitlements] = useState<Entitlement[]>([]);
  const [watcher, setWatcher] = useState<WatcherHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [grantUserId, setGrantUserId] = useState("");
  const [grantPlanId, setGrantPlanId] = useState("");
  const [grantLoading, setGrantLoading] = useState(false);
  const [grantResult, setGrantResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, q, p, e, w] = await Promise.all([
        api("/api/admin/billing/status") as Promise<AdminBillingStatus>,
        api("/api/admin/billing/quotes") as Promise<{ quotes: Quote[] }>,
        api("/api/admin/billing/payments") as Promise<{ payments: Payment[] }>,
        api("/api/admin/billing/entitlements") as Promise<{ entitlements: Entitlement[] }>,
        api("/api/admin/billing/watcher") as Promise<WatcherHealth>,
      ]);
      setBillingStatus(s);
      setQuotes(q.quotes.slice().reverse().slice(0, 20));
      setPayments(p.payments.slice().reverse().slice(0, 20));
      setEntitlements(e.entitlements);
      setWatcher(w);
    } catch (err) {
      console.error("billing admin load failed", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleGrant = async () => {
    if (!grantUserId || !grantPlanId) return;
    setGrantLoading(true);
    setGrantResult(null);
    try {
      await api("/api/admin/billing/grant", {
        method: "POST",
        body: JSON.stringify({ userId: grantUserId, planId: grantPlanId }),
      });
      setGrantResult("Granted successfully");
      void load();
    } catch (err) {
      setGrantResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGrantLoading(false);
    }
  };

  const handleRevoke = async (userId: string) => {
    if (!confirm(`Revoke entitlement for ${userId}?`)) return;
    try {
      await api("/api/admin/billing/revoke", {
        method: "POST",
        body: JSON.stringify({ userId }),
      });
      void load();
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-[13px] text-ink-secondary"><Loader2 size={14} className="animate-spin" /> Loading…</div>;
  }

  return (
    <div className="space-y-4">
      {/* Configuration overview */}
      <Card title="Billing configuration" subtitle="Treasury and chain configuration status.">
        <div className="space-y-3">
          {billingStatus?.testnetMode && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
              NATION_BILLING_TESTNET=1 — testnet mode active
            </div>
          )}
          <div className="space-y-1.5">
            {billingStatus?.chainsAdmin.map((c) => (
              <div key={c.chainId} className="flex items-center justify-between text-[13px]">
                <span className="text-ink">{c.label} ({c.tokenSymbol})</span>
                <span className={c.treasuryConfigured ? "text-success" : "text-warning"}>
                  {c.treasuryConfigured ? "Treasury configured" : "Treasury not set"}
                </span>
              </div>
            ))}
          </div>
          <div className="border-t border-hairline/30 pt-2 text-[11px] text-ink-secondary">
            Set NATION_TREASURY_BASE and/or NATION_TREASURY_ROBINHOOD to enable payments on each chain.
          </div>
        </div>
      </Card>

      {/* Watcher health */}
      <Card title="Chain watcher" subtitle="Background poller that watches for incoming transfers.">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className={cn("size-2 rounded-full", watcher?.running ? "bg-success" : "bg-warning")} />
            <span className="text-[13px] text-ink">{watcher?.running ? "Running" : "Not running"}</span>
            <button type="button" onClick={() => void load()} className="ml-auto text-[12px] text-accent hover:underline">
              <RefreshCw size={12} />
            </button>
          </div>
          {watcher?.chains.map((c) => (
            <div key={c.chainId} className="rounded-lg bg-inset px-3 py-2 text-[12px]">
              <div className="font-medium text-ink">{c.label}</div>
              <div className="text-ink-secondary">
                Last block: {c.lastProcessedBlock ?? "—"} · Last poll: {c.lastPollAt ? new Date(c.lastPollAt).toLocaleTimeString() : "—"}
              </div>
              {c.lastError && <div className="mt-0.5 text-danger">{c.lastError}</div>}
            </div>
          ))}
        </div>
      </Card>

      {/* Manual grant */}
      <Card title="Manual grant" subtitle="Grant a plan to a user by their user ID (email or session ID).">
        <div className="space-y-2">
          <input
            type="text"
            placeholder="User ID (email)"
            value={grantUserId}
            onChange={(e) => setGrantUserId(e.target.value)}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder-ink-secondary/50 focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <select
            value={grantPlanId}
            onChange={(e) => setGrantPlanId(e.target.value)}
            className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            <option value="">Select plan…</option>
            {billingStatus?.plans.map((p) => (
              <option key={p.id} value={p.id}>{p.label} (${(p.usdCents / 100).toFixed(2)}/mo)</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!grantUserId || !grantPlanId || grantLoading}
            onClick={() => void handleGrant()}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            {grantLoading ? <Loader2 size={14} className="animate-spin" /> : null}
            Grant access
          </button>
          {grantResult && <p className="text-[12px] text-ink-secondary">{grantResult}</p>}
        </div>
      </Card>

      {/* Entitlements */}
      <Card title="Active entitlements" subtitle="Users with plan access.">
        {entitlements.length === 0 ? (
          <p className="text-[13px] text-ink-secondary">No entitlements yet.</p>
        ) : (
          <div className="space-y-2">
            {entitlements.map((e) => (
              <div key={e.userId} className="flex items-start justify-between gap-4 rounded-lg bg-inset px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium text-ink">{e.userId}</div>
                  <div className="text-[11px] text-ink-secondary">
                    {e.planLabel} · {e.creditsBalance.toLocaleString()} credits · expires {new Date(e.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevoke(e.userId)}
                  className="shrink-0 text-[11px] text-danger hover:underline"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Recent payments */}
      <Card title="Recent payments" subtitle="Last 20 confirmed on-chain payments.">
        {payments.length === 0 ? (
          <p className="text-[13px] text-ink-secondary">No payments yet.</p>
        ) : (
          <div className="space-y-1.5">
            {payments.map((p) => (
              <div key={p.id} className="rounded-lg bg-inset px-3 py-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink truncate max-w-[180px]">{p.userId}</span>
                  <span className="text-ink-secondary">{p.tokenSymbol} · {p.planId}</span>
                </div>
                <div className="text-ink-secondary">
                  {new Date(p.confirmedAt).toLocaleString()} · {p.creditsGranted.toLocaleString()} credits
                </div>
                <div className="truncate font-mono text-[10px] text-ink-secondary/70">{p.txHash}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Recent quotes */}
      <Card title="Recent quotes" subtitle="Last 20 payment quotes (pending and settled).">
        {quotes.length === 0 ? (
          <p className="text-[13px] text-ink-secondary">No quotes yet.</p>
        ) : (
          <div className="space-y-1.5">
            {quotes.map((q) => (
              <div key={q.id} className="rounded-lg bg-inset px-3 py-2 text-[12px]">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-ink truncate max-w-[180px]">{q.userId}</span>
                  <span className={cn(
                    "rounded px-1.5 py-px text-[10px] font-medium",
                    q.status === "confirmed" ? "bg-success/20 text-success"
                      : q.status === "pending" ? "bg-accent/20 text-accent"
                        : q.status === "expired" ? "bg-warning/20 text-warning"
                          : "bg-control text-ink-secondary",
                  )}>{q.status}</span>
                </div>
                <div className="text-ink-secondary">{q.amountDisplay} · {new Date(q.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

const TABS = [
  { id: "openrouter", label: "OpenRouter", icon: Server },
  { id: "engines", label: "Engines", icon: Terminal },
  { id: "keys", label: "Keys & Integrations", icon: PlugZap },
  { id: "payments", label: "Payments", icon: CreditCard },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function NationAdminPage() {
  const { state, dispatch } = useStore();
  const [tab, setTab] = useState<TabId>("openrouter");

  const admin = isProductAdmin({
    remoteClient: Boolean(window.ogb?.remoteClient),
    pinRequired: state.config?.adminGate?.pinRequired,
    isProductOwner: state.config?.isProductOwner,
  });

  if (!admin) {
    return (
      <main className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 bg-app px-6 text-ink-secondary">
        <ShieldCheck size={32} className="text-ink-secondary/50" />
        <div className="text-center">
          <div className="text-[15px] font-semibold text-ink">Admin access required</div>
          <div className="mt-1 text-[13px]">This page is only available to the account owner.</div>
        </div>
        <button
          type="button"
          onClick={() => dispatch({ type: "showChat" })}
          className="mt-2 flex items-center gap-2 rounded-lg bg-control px-3 py-2 text-[13px] text-ink hover:bg-raised-hover"
        >
          <ChevronLeft size={14} />
          Back to chat
        </button>
      </main>
    );
  }

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-app">
      {/* Header */}
      <div className="shrink-0 border-b border-hairline/30 px-6 py-4">
        <div className="flex items-center gap-3">
          <ShieldCheck size={20} className="text-accent" />
          <div>
            <h1 className="text-[16px] font-semibold text-ink">Nation Admin</h1>
            <p className="text-[12px] text-ink-secondary">Owner-only configuration for OpenRouter, engines, and integrations</p>
          </div>
        </div>
        {/* Tab bar */}
        <div className="mt-4 flex gap-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] transition-colors",
                tab === id
                  ? "bg-control font-medium text-ink"
                  : "text-ink-secondary hover:bg-control/50 hover:text-ink",
              )}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-[700px]">
          {tab === "openrouter" && <OpenRouterSection />}
          {tab === "engines" && <EnginesSettings />}
          {tab === "keys" && <ConnectionsSection />}
          {tab === "payments" && <PaymentsSection />}
        </div>
      </div>
    </main>
  );
}
