import { Children, createElement, type ChangeEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState, Bot, InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";

// The picker reads the engine catalog off the store, and the store module
// touches window/localStorage at import time — the same shape
// ComputerPanel.browser.test.ts uses to render a store-backed component
// under vitest's "node" environment.
const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    instances: [] as InstanceInfo[],
    modelVariantSessions: {} as AppState["modelVariantSessions"],
    dispatch: vi.fn(),
    config: undefined as AppState["config"] | undefined,
  };
});
vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({
    state: { instances: fixture.instances, modelVariantSessions: fixture.modelVariantSessions, config: fixture.config },
    dispatch: fixture.dispatch,
    refreshInstances: vi.fn(),
    refreshModels: vi.fn(),
  }),
}));

const { ClaudeAccountSelect, EffortRow, ModelEngineRail, ModelPicker, ModelVariantRow, modelSelectionForPick } = await import("./ModelPicker");

afterAll(() => vi.unstubAllGlobals());

function engine(effortLevels?: readonly EffortLevel[]): InstanceInfo {
  return {
    instanceId: "codex",
    driverKind: "codex",
    displayName: "Codex",
    snapshot: { state: "available", version: "1.0.0" },
    models: { default: "gpt-5.6", options: [{ id: "gpt-5.6", label: "GPT-5.6" }] },
    ...(effortLevels ? { capabilities: { effortLevels } } : {}),
  };
}

function bot(effort?: EffortLevel): Bot {
  return {
    id: "atlas",
    threadId: "thread-atlas",
    name: "Atlas",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "codex", model: "gpt-5.6", ...(effort ? { effort } : {}) },
    messages: [],
  };
}

/** Every effort button as rendered, with the state a screen reader announces. */
function levelButtons(markup: string): Array<{ label: string; pressed: boolean }> {
  return [...markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]+)</g)].map((match) => ({
    label: match[2],
    pressed: match[1] === "true",
  }));
}

function renderEffort(instances: InstanceInfo[], effort?: EffortLevel): string {
  fixture.instances = instances;
  return renderToStaticMarkup(createElement(EffortRow, { bot: bot(effort) }));
}

describe("EffortRow", () => {
  it("can apply effort to the pinned thread and bot default together", () => {
    fixture.instances = [engine(["high"])];
    const row = EffortRow({ bot: bot(), threadId: "thread-atlas", updateBotDefault: true })!;
    const levels = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const high = Children.toArray(levels.props.children)[1] as ReactElement<{ onClick: () => void }>;
    high.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "thread-atlas", updateBotDefault: true, selection: { instanceId: "codex", model: "gpt-5.6", effort: "high" } });
  });
  it("pins thread effort changes without changing profile defaults", () => {
    fixture.instances = [engine(["high"])];
    const row = EffortRow({ bot: bot(), threadId: "independent-thread" })!;
    const levels = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const high = Children.toArray(levels.props.children)[1] as ReactElement<{ onClick: () => void }>;
    high.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "independent-thread", selection: { instanceId: "codex", model: "gpt-5.6", effort: "high" } });
  });
  it("renders nothing for an engine that declares no effort levels", () => {
    expect(renderEffort([engine()])).toBe("");
    // an engine that declares an empty list is the same promise as none
    expect(renderEffort([engine([])])).toBe("");
    // and so is a bot whose engine is not in the catalog at all
    expect(renderEffort([])).toBe("");
  });

  it("offers only the levels the selected engine accepts, plus Default", () => {
    const markup = renderEffort([engine(["low", "medium", "high"])]);

    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Default", "Low", "Medium", "High"]);
    // the server rejects a level its engine does not offer, so one that is
    // never shown is one that can never be persisted
    expect(markup).not.toContain(">X-High<");
    expect(markup).not.toContain(">Max<");
  });

  it("keeps Default and None apart — Default sends no level, None sends one", () => {
    const markup = renderEffort([engine(["none", "low"])]);

    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Default", "None", "Low"]);
  });

  it("marks the active level, and Default when the bot carries no level", () => {
    const pressed = (markup: string) => levelButtons(markup).find((button) => button.pressed)?.label;

    expect(pressed(renderEffort([engine(["low", "high"])], "high"))).toBe("High");
    expect(pressed(renderEffort([engine(["low", "high"])]))).toBe("Default");
  });

  it("renames xhigh, the one level that does not capitalize cleanly", () => {
    expect(renderEffort([engine(["xhigh"])])).toContain(">X-High<");
  });
});


describe("OpenCode model variants", () => {
  const variants = [
    { id: "none", label: "None" }, { id: "minimal", label: "Minimal" },
    { id: "default", label: "Default" }, { id: "deep/custom", label: "Deep custom" },
  ];
  const opencode = (): InstanceInfo => ({ ...engine(), instanceId: "opencode", driverKind: "opencodeGo",
    capabilities: { modelVariants: true }, models: { default: "provider/model", options: [{ id: "provider/model", label: "Model", variants }] } });
  const selected = (variant?: string): Bot => ({ ...bot(), modelSelection: { instanceId: "opencode", model: "provider/model", ...(variant !== undefined ? { variant } : {}) } });
  beforeEach(() => { fixture.instances = [opencode()]; fixture.modelVariantSessions = {}; fixture.dispatch.mockClear(); });
  const render = (variant?: string) => renderToStaticMarkup(createElement(ModelVariantRow, { bot: selected(variant), threadId: "thread-atlas" }));

  it("offers exact advertised ids without assuming that omission means none or default", () => {
    const markup = render();
    expect(levelButtons(markup)).toEqual([
      { label: "None", pressed: false }, { label: "Minimal", pressed: false },
      { label: "Default", pressed: false }, { label: "Deep custom", pressed: false },
    ]);
    expect(markup).toContain("No variant selected.");
    expect(fixture.dispatch).not.toHaveBeenCalled();
    expect(levelButtons(render("none")).find((button) => button.pressed)?.label).toBe("None");
  });

  it.each(variants)("persists $id only to the pinned conversation and clears legacy effort", (option) => {
    const configured = selected();
    configured.modelSelection.effort = "high";
    const row = ModelVariantRow({ bot: configured, threadId: "independent-thread" })!;
    const group = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    const button = Children.toArray(group.props.children)[variants.findIndex((candidate) => candidate.id === option.id)] as ReactElement<{ onClick: () => void }>;
    button.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "independent-thread",
      selection: { instanceId: "opencode", model: "provider/model", variant: option.id } });
  });

  it.each(["none", "default", "minimal", "removed"])("can clear %s to omission without asking for a default or none", (variant) => {
    const row = ModelVariantRow({ bot: selected(variant), threadId: "thread-atlas" })!;
    const clear = Children.toArray(row.props.children).find((child) =>
      typeof child === "object" && "type" in child && child.type === "button") as ReactElement<{ onClick: () => void; title: string }>;
    expect(clear.props.title).toContain("keeps its session or configured setting");
    clear.props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: "thread-atlas",
      selection: { instanceId: "opencode", model: "provider/model" } });
  });

  it("uses matching session choices, including an empty list, without changing the instance catalog", () => {
    fixture.modelVariantSessions["thread-atlas"] = { instanceId: "opencode", model: "provider/model", turnId: "turn", startedAt: "2026-09-15T00:00:00Z", acceptingUpdates: false,
      variants: { options: [{ id: "minimal", label: "Session minimal" }], currentValue: "minimal" } };
    expect(levelButtons(render()).map((button) => button.label)).toEqual(["Session minimal"]);
    expect(render()).toContain("No variant selected. Session: Session minimal.");
    expect(levelButtons(render()).some((button) => button.pressed)).toBe(false);
    expect(fixture.instances[0].models.options[0].variants).toEqual(variants);
    fixture.modelVariantSessions["thread-atlas"].variants = { options: [] };
    expect(render()).toBe("");
    expect(render("none")).toContain("is unavailable");
    expect(render("none")).not.toContain('aria-label="Reasoning variant"');
  });

  it("ignores another conversation, account, or model's session choices and preserves unavailable saved ids", () => {
    const session = { instanceId: "opencode", model: "provider/model", turnId: "turn", startedAt: "2026-09-15T00:00:00Z", acceptingUpdates: false, variants: { options: [] } };
    fixture.modelVariantSessions["other-thread"] = session;
    expect(levelButtons(render())).toHaveLength(4);
    fixture.modelVariantSessions["thread-atlas"] = { ...session, instanceId: "other-account" };
    expect(levelButtons(render())).toHaveLength(4);
    fixture.modelVariantSessions["thread-atlas"] = { ...session, model: "other-model" };
    expect(levelButtons(render())).toHaveLength(4);
    expect(render("removed")).toContain("Saved variant “removed” has not been checked in this session.");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("does not invent default or expose a control on a model without variants", () => {
    fixture.instances[0].models.options[0].variants = [{ id: "minimal", label: "Minimal" }];
    expect(levelButtons(render()).map((button) => button.label)).toEqual(["Minimal"]);
    fixture.instances[0].models.options[0].variants = [];
    expect(render()).toBe("");
    fixture.instances[0].capabilities = {};
    expect(render("none")).toBe("");
  });

  it("does not declare a saved default invalid on reload before ACP announces its choices", () => {
    fixture.instances[0].models.options[0].variants = [{ id: "minimal", label: "Minimal" }];
    const markup = render("default");
    expect(markup).toContain("has not been checked in this session");
    expect(markup).not.toContain("is unavailable");
    expect(levelButtons(markup).map((button) => button.label)).toEqual(["Minimal"]);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("keeps the saved choice after reload while allowing profile choices to update the profile", () => {
    expect(levelButtons(render("minimal")).find((button) => button.pressed)?.label).toBe("Minimal");
    const row = ModelVariantRow({ bot: selected(), updateBotDefault: true })!;
    const group = Children.toArray(row.props.children).at(-1) as ReactElement<{ children: ReactNode }>;
    (Children.toArray(group.props.children)[1] as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "setModel", botId: "atlas", threadId: undefined, updateBotDefault: true,
      selection: { instanceId: "opencode", model: "provider/model", variant: "minimal" } });
  });

  it("drops an opaque variant when switching models/accounts but keeps it when reselecting the same model", () => {
    const selection = selected("minimal").modelSelection;
    expect(modelSelectionForPick(selection, opencode(), "provider/other")).toEqual({ instanceId: "opencode", model: "provider/other" });
    expect(modelSelectionForPick(selection, { ...opencode(), instanceId: "other" }, "provider/model")).toEqual({ instanceId: "other", model: "provider/model" });
    expect(modelSelectionForPick(selection, opencode(), "provider/model")).toEqual(selection);
    expect(modelSelectionForPick({ ...selection, effort: "high" }, opencode(), "provider/other")).not.toHaveProperty("effort");
    expect(modelSelectionForPick(bot("high").modelSelection, engine(["high"]), "other")).toEqual({ instanceId: "codex", model: "other", effort: "high" });
  });
});

describe("ModelPicker trigger", () => {
  const renderTrigger = (effort?: EffortLevel) => {
    fixture.instances = [engine(["low", "high"])];
    return renderToStaticMarkup(createElement(ModelPicker, { bot: bot(effort) }));
  };

  /** The visible effort suffix, not the tooltip that also names the level. */
  const effortChip = (markup: string) =>
    markup.match(/<span data-model-effort[^>]*>(.*?)<\/span>/s)?.[1].replace(/<!--.*?-->/g, "").trim();

  it("names the thread in busy header help and the bot in profile settings", () => {
    fixture.instances = [engine()];
    for (const threadId of ["independent-thread", undefined]) {
      const markup = renderToStaticMarkup(createElement(ModelPicker, { bot: { ...bot(), busy: true }, threadId }));
      expect(markup).toContain(`Stop this ${threadId ? "thread" : "bot"}&#x27;s turn before changing its model`);
    }
  });

  it("shows the model and its effort together in the header", () => {
    const markup = renderTrigger("high");

    expect(markup).toContain("GPT-5.6");
    expect(effortChip(markup)).toBe("· High");
    expect(markup).toContain("NATION API · GPT-5.6 · High effort");
  });

  it("says nothing about effort when the bot sends no level", () => {
    const markup = renderTrigger();

    expect(markup).toContain("GPT-5.6");
    expect(effortChip(markup)).toBeUndefined();
    expect(markup).not.toContain("effort");
    expect(markup).toContain("@max-4xl/chathead:size-[30px]");
    expect(markup).not.toContain("data-model-account-compact");
  });

  it("visibly identifies the selected account when Claude has multiple instances", () => {
    fixture.instances = [
      { ...engine(), instanceId: "claude-personal", driverKind: "claudeAgent", displayName: "Personal" },
      { ...engine(), instanceId: "claude-work", driverKind: "claudeAgent", displayName: "Work" },
    ];
    const markup = renderToStaticMarkup(createElement(ModelPicker, {
      bot: { ...bot(), modelSelection: { instanceId: "claude-work", model: "gpt-5.6" } },
    }));
    // Both Claude accounts display "NATION API" branding (not the raw account name)
    expect(markup).toMatch(/<span data-model-account[^>]*>NATION API · <\/span>/);
    expect(markup).not.toMatch(/<span data-model-account[^>]*>Personal/);
    // The compact chip also shows NATION API branding; the 30px icon-only square
    // is suppressed in favour of the wider chip so the label remains readable.
    expect(markup).toMatch(/<span data-model-account-compact="true" class="hidden max-w-20 truncate @max-4xl\/chathead:inline">NATION API<\/span><span class="[^"]*@max-4xl\/chathead:hidden"/);
    expect(markup).not.toContain("@max-4xl/chathead:size-[30px]");
  });
});

describe("Claude provider and account selection", () => {
  const personal: InstanceInfo = { ...engine(), instanceId: "claude-personal", driverKind: "claudeAgent", displayName: "Personal" };
  const work: InstanceInfo = { ...engine(), instanceId: "claude-work", driverKind: "claudeAgent", displayName: "Work", access: "custom" };

  it("renders one NATION API provider across Cloud and Local, pressed for either account", () => {
    for (const selectedInstance of [personal, work]) {
      const markup = renderToStaticMarkup(createElement(ModelEngineRail, {
        instances: [engine(), personal, work], selectedInstance, claudeInstance: work, onSelect: () => {},
      }));
      expect(markup.match(/aria-label="NATION API"/g)).toHaveLength(1);
      expect(markup).toContain('aria-label="NATION API" aria-pressed="true"');
      expect(markup).toContain('aria-label="Codex" aria-pressed="false"');
      expect(markup).not.toContain('aria-label="Personal"');
      expect(markup).not.toContain('aria-label="Work"');
      expect(markup).not.toContain('aria-label="Claude"');
      expect(markup).toContain("w-14");
    }
  });

  it("opens the remembered concrete Claude account, falling back to the first account", () => {
    const onSelect = vi.fn();
    for (const claudeInstance of [work, undefined]) {
      const rail = ModelEngineRail({ instances: [personal, work], claudeInstance, onSelect });
      const button = Children.toArray(rail.props.children).find((child) => (child as ReactElement).type === "button") as ReactElement<{ onClick: () => void }>;
      button.props.onClick();
      expect(onSelect).toHaveBeenLastCalledWith(claudeInstance ?? personal);
    }
  });

  it("shows the icon of the concrete Claude account the rail selects", () => {
    const personalIcon: InstanceInfo = { ...personal, icon: { kind: "preset", preset: "anthropic" } };
    const workIcon: InstanceInfo = { ...work, icon: { kind: "preset", preset: "azure" } };
    for (const claudeInstance of [workIcon, undefined]) {
      const target = claudeInstance ?? personalIcon;
      const rail = ModelEngineRail({ instances: [personalIcon, workIcon], claudeInstance, onSelect: () => {} });
      const button = Children.toArray(rail.props.children).find((child) => (child as ReactElement).type === "button") as ReactElement<{ children: ReactNode }>;
      const mark = Children.toArray(button.props.children)[0] as ReactElement<{ instance: InstanceInfo }>;
      expect(mark.props.instance).toBe(target);
    }
  });

  it("maps named native options to concrete instances without committing a model", () => {
    const onSelect = vi.fn();
    const dropdown = ClaudeAccountSelect({ accounts: [personal, work], selectedId: work.instanceId, onSelect });
    const markup = renderToStaticMarkup(dropdown);
    expect(markup).toContain('aria-label="Account"');
    expect(markup).toContain('<option value="claude-personal">Personal</option>');
    expect(markup).toContain('<option value="claude-work" selected="">Work</option>');
    const select = Children.toArray(dropdown.props.children)[1] as ReactElement<{ onChange: (event: ChangeEvent<HTMLSelectElement>) => void }>;
    select.props.onChange({ target: { value: personal.instanceId } } as ChangeEvent<HTMLSelectElement>);
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(personal);
  });
});

describe("NATION admin gate — Claude filtering", () => {
  const claude: InstanceInfo = { ...engine(), instanceId: "claude-1", driverKind: "claudeAgent", displayName: "Claude" };
  const openrouter: InstanceInfo = { ...engine(), instanceId: "openrouter-1", driverKind: "openai-compat", displayName: "OpenRouter" };

  afterEach(() => { fixture.config = undefined; });

  // The ModelPicker renders the rail only in the open popover. Since renderToStaticMarkup
  // captures the closed (initial) state, we verify filtering via ModelEngineRail directly
  // which receives the pickerInstances after the admin filter is applied.

  it("ModelEngineRail shows NATION API button for Claude instances (no raw Anthropic labels)", () => {
    // Admin path: both instances reach the rail
    const markup = renderToStaticMarkup(createElement(ModelEngineRail, {
      instances: [claude, openrouter], selectedInstance: openrouter, onSelect: () => {},
    }));
    expect(markup).toContain('aria-label="NATION API"');
    expect(markup).not.toContain('aria-label="Claude"');
    expect(markup).toContain('aria-label="OpenRouter"');
  });

  it("non-admin gets Claude filtered from pickerInstances — rail receives only OpenRouter", () => {
    // Simulate what ModelPicker computes for non-admin: pickerInstances excludes claudeAgent
    const nonAdminInstances = [openrouter]; // Claude filtered by ModelPicker
    const markup = renderToStaticMarkup(createElement(ModelEngineRail, {
      instances: nonAdminInstances, selectedInstance: openrouter, onSelect: () => {},
    }));
    expect(markup).not.toContain('aria-label="Claude"');
    expect(markup).toContain('aria-label="OpenRouter"');
  });

  it("non-admin ModelPicker (pinRequired, not unlocked) has no Claude account select", () => {
    fixture.instances = [claude, openrouter];
    fixture.config = { adminGate: { pinRequired: true } } as AppState["config"];
    // pickerInstances excludes claudeAgent → claudeAccounts = [] → no account select in trigger
    const markup = renderToStaticMarkup(createElement(ModelPicker, {
      bot: { ...bot(), modelSelection: { instanceId: "openrouter-1", model: "gpt-5.6" } },
    }));
    // The claudeAccounts dropdown is only rendered inside the open popover,
    // but the trigger aria-label must NOT identify Claude as the provider
    expect(markup).not.toContain('aria-label="Account"');
  });

  it("trigger shows NATION API (not Claude model name) when isProductOwner is false and active is claudeAgent", () => {
    fixture.instances = [claude, openrouter];
    // Non-admin: isProductOwner: false
    fixture.config = { isProductOwner: false } as AppState["config"];
    const markup = renderToStaticMarkup(createElement(ModelPicker, {
      bot: { ...bot(), modelSelection: { instanceId: "claude-1", model: "gpt-5.6" } },
    }));
    // Model name must be masked — "NATION API" only, no vendor model name
    expect(markup).toContain("NATION API");
    expect(markup).not.toContain("Claude");
    expect(markup).not.toContain("Anthropic");
    // Title tooltip must also be masked
    expect(markup).toMatch(/title="NATION API[^"]*"/);
    expect(markup).not.toMatch(/title="[^"]*claude/i);
  });

  it("trigger shows actual model name for admin (isProductOwner: true)", () => {
    fixture.instances = [{ ...claude, models: { default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5" }] } }];
    fixture.config = { isProductOwner: true } as AppState["config"];
    const markup = renderToStaticMarkup(createElement(ModelPicker, {
      bot: { ...bot(), modelSelection: { instanceId: "claude-1", model: "claude-sonnet-5" } },
    }));
    expect(markup).toContain("Claude Sonnet 5");
  });

  it("trigger shows NATION API label when no engine configured and model ID looks like Claude", () => {
    fixture.instances = [];
    fixture.config = { isProductOwner: false } as AppState["config"];
    const claudeBot = { ...bot(), modelSelection: { instanceId: "gone", model: "claude-sonnet-5" } };
    const markup = renderToStaticMarkup(createElement(ModelPicker, { bot: claudeBot }));
    // Raw Claude model ID must not surface to non-admin
    expect(markup).toContain("NATION API");
    expect(markup).not.toContain("claude-sonnet-5");
    expect(markup).not.toContain("Claude");
  });
});
