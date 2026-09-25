import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("NATION mounts Gmail through Composio, waits for permission, and honors the bot opt-out", async () => {
  let origin = "";
  let toolCalls = 0;
  let requestTool = true;
  const modelRequests: any[] = [];
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const path = new URL(req.url!, "http://fixture").pathname;
    const json = (value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (path === "/api/v3.1/tool_router/session/trs_fixture") return json({
      session_id: "trs_fixture", mcp: { type: "http", url: origin + "/mcp" },
      config: { user_id: "fixture_user", multi_account: { enable: true } },
    });
    if (path === "/broker/v1/mcp") {
      expect(req.headers.authorization).toBe("Bearer " + "a".repeat(64));
      if (body.id === undefined) { res.writeHead(202); res.end(); return; }
      let result: unknown = {};
      if (body.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
      if (body.method === "tools/list") result = { tools: [{ name: "GMAIL_FETCH_EMAILS", description: "List synthetic fixture emails", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
      if (body.method === "tools/call") { toolCalls++; result = { content: [{ type: "text", text: "fixture Gmail receipt: 2 synthetic messages" }] }; }
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    if (path.endsWith("/chat/completions")) {
      expect(req.headers.authorization).toBe("Bearer nation_fixture_key_only");
      modelRequests.push(body);
      const tool = body.tools?.find((item: any) => item.function.name === "apps_gmail_fetch_emails");
      const completed = body.messages.some((item: any) => item.role === "tool");
      const delta = requestTool && tool && !completed
        ? { tool_calls: [{ index: 0, id: "gmail-fixture", type: "function", function: { name: tool.function.name, arguments: "{}" } }] }
        : { content: "Synthetic connector check complete." };
      res.setHeader("content-type", "text/event-stream");
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 4, completion_tokens: 3, cost: 0.01 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    if (path.includes("toolkits") || path.includes("connected_accounts") || path.includes("auth_configs")) return json({ items: [] });
    if (path.startsWith("/broker/")) return json({ services: {}, items: [] });
    res.statusCode = 404; json({});
  });
  await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined, origin, origin);
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(r.ok, path).toBe(true); return r.json() as Promise<any>;
  };
  try {
    expect((await api("/api/config")).composio.configured).toBe(true);
    const { bot } = await api("/api/bots", "POST", { name: "Connector fixture" });
    await api("/api/bots/" + bot.id, "PATCH", { computer: "off", composio: true, autoApprove: false });
    const wait = () => runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as Promise<any>;
    await api("/api/bots/" + bot.id + "/messages", "POST", { text: "List the fixture Gmail messages.", threadId: bot.threadId });
    const pending = await wait();
    expect(pending.status, JSON.stringify(pending)).toBe("needs-user");
    expect(toolCalls).toBe(0);
    const current = (await api("/api/bots")).bots.find((item: any) => item.id === bot.id);
    const card = current.messages.find((item: any) => item.card?.requestId && !item.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    await api("/api/bots/" + bot.id + "/respond", "POST", { threadId: bot.threadId, requestId: card.requestId, behavior: "allow" });
    expect((await wait()).status).toBe("settled");
    expect(toolCalls).toBe(1);
    expect(modelRequests.at(-1).messages.some((item: any) => item.role === "tool" && item.content.includes("fixture Gmail receipt"))).toBe(true);
    expect(JSON.stringify(modelRequests)).not.toContain("ak_connector_fixture_only");
    requestTool = false;
    await api("/api/bots/" + bot.id, "PATCH", { composio: false });
    await api("/api/bots/" + bot.id + "/messages", "POST", { text: "Check the bot opt-out.", threadId: bot.threadId });
    expect((await wait()).status).toBe("settled");
    expect(modelRequests.at(-1).tools.some((item: any) => item.function.name.startsWith("apps_"))).toBe(false);
    expect(toolCalls).toBe(1);
  } finally { await fixture.close(); provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); }
}, 75_000);
