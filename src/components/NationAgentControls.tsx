import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import { Card } from "./SettingsPrimitives";

/** GET /api/admin/controls: configured state only, never a credential. */
export interface AgentControls {
  models: {
    fast: string; standard: string; strong: string; enabled: boolean;
    configured: Array<"fast" | "standard" | "strong">;
    sources: Record<"defaultModel" | "fast" | "standard" | "strong", "admin" | "environment" | "default">;
  };
  tools: Record<"browser" | "computers" | "webSearch" | "webRead", { enabled: boolean; available: boolean }> & { connectedApps: { available: boolean } };
  search: { provider: string | null; source: string | null };
  health: Record<string, { configured?: boolean; ready?: boolean; reason?: string }>;
}

const inputClass = "w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-sm text-ink";

const TOOLS = [
  { key: "computers", feature: "computers", label: "Agent computers", hint: "Cloud and self-hosted computers for every agent. Each member gets their own." },
  { key: "browser", feature: "browser", label: "Built-in browser", hint: "A private browser session per member for each agent." },
  { key: "webSearch", feature: "webSearch", label: "Web search", hint: "web_search, on NATION's search provider, charged to the member's credit." },
  { key: "webRead", feature: "webRead", label: "Web reader", hint: "web_read: reads public pages as text, charged to the member's credit." },
] as const;

const HEALTH: Array<[string, string]> = [
  ["nationApi", "NATION API"], ["search", "Web search provider"], ["cloudComputer", "Cloud computers"],
  ["vps", "Self-hosted VPS"], ["browserEngine", "Browser engine"], ["connectedApps", "Connected apps backend"],
];

export function NationAgentControls() {
  const [controls, setControls] = useState<AgentControls | null>(null);
  const [models, setModels] = useState({ defaultModel: "", fast: "", standard: "", strong: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try { setControls(await api<AgentControls>("/api/admin/controls")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Controls could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async (patch: unknown, done = "Settings saved.") => {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await api("/api/config", { method: "PUT", body: JSON.stringify(patch) }); await load(); setNotice(done); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Settings could not be saved."); }
    finally { setBusy(false); }
  };

  if (!controls) return <p className="text-sm text-ink-secondary">{error || "Loading controls…"}</p>;
  const routed = Object.fromEntries(Object.entries(models).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));
  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-success">{notice}</p>}
    <Card title="Tools for every agent" subtitle="Members use these without setup. Switching one off removes it from every agent.">
      <ul className="space-y-3">
        {TOOLS.map(({ key, feature, label, hint }) => {
          const tool = controls.tools[key];
          return <li key={key} className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-ink">{label}</div>
              <div className="text-xs text-ink-secondary">{hint}{!tool.available && " Not configured yet."}</div>
            </div>
            <button type="button" disabled={busy} aria-pressed={tool.enabled}
              onClick={() => void save({ features: { [feature]: !tool.enabled } })}
              className={cn("ui-button shrink-0 disabled:opacity-50", tool.enabled ? "" : "opacity-80")}>
              {tool.enabled ? "On" : "Off"}
            </button>
          </li>;
        })}
      </ul>
      <p className="mt-3 text-xs text-ink-secondary">
        Search provider: {controls.search.provider === "openrouter" ? "NATION API web search" : controls.search.provider ?? "not configured"}
        {controls.search.source ? ` (${controls.search.source})` : ""}. Change it and its key under Apps &amp; computers.
      </p>
    </Card>
    <Card title="Models and routing" subtitle="NATION API picks the tier for each hosted turn (easy, normal, hard). Only these models are used.">
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-secondary">Routing</dt><dd className="text-ink">{controls.models.enabled ? "On" : "Off (default model for every turn)"}</dd>
        <dt className="text-ink-secondary">Easy</dt><dd className="text-ink"><code>{controls.models.fast}</code> · {controls.models.sources.fast}</dd>
        <dt className="text-ink-secondary">Normal</dt><dd className="text-ink"><code>{controls.models.standard}</code> · {controls.models.sources.standard}</dd>
        <dt className="text-ink-secondary">Hard</dt><dd className="text-ink"><code>{controls.models.strong}</code> · {controls.models.sources.strong}</dd>
        <dt className="text-ink-secondary">Default</dt><dd className="text-ink">{controls.models.sources.defaultModel}</dd>
      </dl>
      <button type="button" disabled={busy} className="ui-button mb-4 disabled:opacity-50"
        onClick={() => void save({ modelRouting: { enabled: !controls.models.enabled } })}>
        {controls.models.enabled ? "Turn routing off" : "Turn routing on"}
      </button>
      <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (Object.keys(routed).length) void save({ modelRouting: routed }, "Models saved.").then(() => setModels({ defaultModel: "", fast: "", standard: "", strong: "" })); }}>
        {([["defaultModel", "Default model"], ["fast", "Easy tier"], ["standard", "Normal tier"], ["strong", "Hard tier"]] as const).map(([key, label]) =>
          <div key={key}>
            <label className="block text-sm text-ink" htmlFor={`model-${key}`}>{label}</label>
            <input id={`model-${key}`} value={models[key]} onChange={event => setModels({ ...models, [key]: event.target.value })}
              placeholder="provider/model · leave empty to keep" className={inputClass} />
          </div>)}
        <button disabled={busy || !Object.keys(routed).length} className="ui-button disabled:opacity-50">Save models</button>
      </form>
    </Card>
    <Card title="Provider health" subtitle="Whether each NATION-managed backend is set up. Credentials are never shown.">
      <ul className="space-y-2">
        {HEALTH.map(([key, label]) => {
          const item = controls.health[key] ?? {};
          const ok = item.configured ?? item.ready ?? false;
          return <li key={key} className="flex items-center gap-2 text-sm text-ink">
            {ok ? <CheckCircle2 size={16} className="text-success" aria-hidden="true" /> : <XCircle size={16} className="text-warning" aria-hidden="true" />}
            <span>{label}</span>
            <span className="text-xs text-ink-secondary">{ok ? "ready" : item.reason ?? "not configured"}</span>
          </li>;
        })}
      </ul>
    </Card>
  </div>;
}
