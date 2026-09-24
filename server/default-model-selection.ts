import type { EffortLevel, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";

interface SelectableInstance {
  instanceId: string;
  driverKind: string;
  snapshot: ProviderSnapshot;
  models: ModelCatalog;
  capabilities?: { effortLevels?: readonly EffortLevel[]; modelVariants?: boolean };
}

/** Keep the configured route through lazy discovery; never select a computer engine implicitly. */
export function selectDefaultModelSelection(
  instances: readonly SelectableInstance[],
  preferred?: ModelSelection,
): ModelSelection {
  if (preferred) {
    const instance = instances.find((candidate) => candidate.instanceId === preferred.instanceId);
    // The saved routing choice remains authoritative while an ACP catalog is
    // warming up (Hermes can accept configured routes absent from discovery).
    // Never replace it with an empty pair or a different provider.
    if (!preferred.instanceId.trim() || !preferred.model.trim()) return { instanceId: "", model: "" };
    const selection = { ...preferred };
    // A saved effort can outlive driver support. Keep the intentional model,
    // but let the provider use its own effort default instead of failing turn 1.
    if (selection.effort && !instance?.capabilities?.effortLevels?.includes(selection.effort)) delete selection.effort;
    return selection;
  }
  const available = instances.filter((instance) => instance.snapshot.state === "available" &&
    instance.snapshot.authenticated !== false && !["claudeAgent", "boxAgent", "computer"].includes(instance.driverKind));
  const pick = available.find((instance) => instance.driverKind === "nation-openrouter")
    ?? available.find((instance) => instance.driverKind === "hermesAgent") ?? available[0];
  return { instanceId: pick?.instanceId ?? "", model: pick?.models.default ?? "" };
}
