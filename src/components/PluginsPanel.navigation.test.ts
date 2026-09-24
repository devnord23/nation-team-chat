import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ surface: "apps" as "apps" | "mcp", owner: true, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({
  api: vi.fn(),
  useStore: () => ({ state: { pluginsSurface: fixture.surface, config: { isProductOwner: fixture.owner } }, dispatch: fixture.dispatch }),
}));
vi.mock("./McpServersPanel", () => ({ McpServersPanel: () => createElement("div", null, "MCP inventory") }));
import { PluginsPanel } from "./PluginsPanel";

type Node = ReactElement<{ children?: ReactNode; role?: string; "aria-selected"?: boolean; onClick?: () => void }>;
function nodes(value: ReactNode): Node[] {
  if (!isValidElement(value)) return [];
  const node = value as Node;
  return [node, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render() {
  let tree!: ReturnType<typeof PluginsPanel>;
  function Capture() { tree = PluginsPanel(); return tree; }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, nodes: nodes(tree) };
}
beforeEach(() => { vi.stubGlobal("window", {}); fixture.surface = "apps"; fixture.owner = true; fixture.dispatch.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe("Plugins surface navigation", () => {
  it("opens the requested surface and persists manual changes through the store", () => {
    fixture.surface = "mcp";
    const initial = render();
    expect(initial.html).toContain("MCP inventory");
    const apps = initial.nodes.find((node) => node.props.role === "tab" && node.props.children === "Connected apps")!;
    expect(apps.props["aria-selected"]).toBe(false);
    apps.props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true, surface: "apps" });
    fixture.surface = "apps";
    const reopened = render();
    expect(reopened.html).not.toContain("MCP inventory");
    const mcp = reopened.nodes.find((node) => node.props.role === "tab" && node.props.children === "MCP servers")!;
    mcp.props.onClick!();
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "togglePlugins", open: true, surface: "mcp" });
    fixture.surface = "mcp";
    expect(render().html).toContain("MCP inventory");
  });

  it("gives members their own connected apps but never the workspace MCP inventory", () => {
    fixture.owner = false;
    fixture.surface = "mcp";
    const member = render();
    expect(member.html).not.toContain("MCP inventory");
    expect(member.nodes.some((node) => node.props.role === "tab" && node.props.children === "MCP servers")).toBe(false);
    expect(member.nodes.some((node) => node.props.role === "tab" && node.props.children === "Connected apps")).toBe(true);
  });
});
