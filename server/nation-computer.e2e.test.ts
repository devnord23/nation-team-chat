// A NATION API bot with an isolated cloud computer attached, against owned
// loopback stand-ins for the Box provider and the NATION API model. Proves:
//   - computer tools mount into a NATION API turn (the model is not switched
//     to the computer's own agent, and billing stays on NATION API),
//   - a screenshot taken by the tool reaches the model as an image,
//   - a shell command runs on this bot's Box only,
//   - while a person holds the computer, the agent's input is refused and
//     nothing reaches the Box.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

// 1x1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const MARKER = "nation-computer-fixture";

it("NATION API drives an isolated computer, sees its screenshots, and yields to a person", async () => {
  const boxes: Array<{ id: string; name: string; state: string }> = [];
  const commands: Array<{ box: string; command: string }> = [];
  const modelRequests: Array<{ auth: string; model: string; tools: string[]; messages: any[] }> = [];
  let script: "screenshot-then-exec" | "exec" | "browser" = "screenshot-then-exec";
  let callSeq = 0;

  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const path = url.pathname;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (path.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      modelRequests.push({ auth: String(req.headers.authorization), model: body.model, tools, messages: body.messages });
      const lastUser = body.messages.map((item: any, index: number) => ({ item, index }))
        .filter(({ item }: any) => item.role === "user" && typeof item.content === "string").at(-1);
      const after = body.messages.slice(lastUser.index + 1);
      const toolReplies = after.filter((item: any) => item.role === "tool");
      const plan = script === "screenshot-then-exec"
        ? [["computer_screenshot", {}], ["computer_execute", { command: `echo ${MARKER}` }]] as const
        : script === "browser"
          ? [["browser_navigate", { url: "https://example.test/" }]] as const
          : [["computer_execute", { command: `echo ${MARKER}` }]] as const;
      const next = plan[toolReplies.length];
      const delta = next && tools.includes(next[0])
        ? { tool_calls: [{ index: 0, id: `call-${++callSeq}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] }
        : { content: `Done. Tool replies: ${toolReplies.map((item: any) => item.content).join(" | ")}` };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 30, completion_tokens: 5, cost: 0.002 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    // Box provider
    if (req.headers.authorization !== "Bearer box_verification_fixture") return json({ ok: false, code: "unauthorized" }, 401);
    if (path === "/boxes" && req.method === "GET") return json({ ok: true, boxes });
    if (path === "/boxes" && req.method === "POST") {
      const box = { id: "bx_" + "23456789abcdefgh".slice(boxes.length, boxes.length + 8).padEnd(8, "k"), name: body.name ?? "", state: "running" };
      boxes.push(box);
      return json({ ok: true, box }, 201);
    }
    let m = path.match(/^\/boxes\/(bx_\w{8})$/);
    if (m) {
      const box = boxes.find((item) => item.id === m![1]);
      if (!box) return json({ ok: false, message: "not found" }, 404);
      if (req.method === "PATCH" && body.name) box.name = body.name;
      return json({ ok: true, box });
    }
    m = path.match(/^\/boxes\/(bx_\w{8})\/commands$/);
    if (m) {
      commands.push({ box: m[1], command: String(body.command) });
      const shot = /ogb-panel/.test(String(body.command));
      return json({ ok: true, exitCode: 0, stdout: shot ? "captured" : String(body.command).includes(MARKER) ? `${MARKER}\n` : "", stderr: "" });
    }
    m = path.match(/^\/boxes\/(bx_\w{8})\/artifacts$/);
    if (m) { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(PNG); return; }
    m = path.match(/^\/boxes\/(bx_\w{8})\/files$/);
    if (m) return json({ ok: true, content: PNG.toString("base64") });
    m = path.match(/^\/boxes\/(bx_\w{8})\/(desktop|resume|stop)$/);
    if (m) return json({ ok: true, desktopUrl: `https://desktop.invalid/${m[1]}` });
    json({ ok: true });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fakeBrowser = fileURLToPath(new URL("./testing/fake-agent-browser.mjs", import.meta.url));
  const fixture = await launchVerificationServer(process.env, undefined, undefined,
    { binaryPath: fakeBrowser, executablePath: fakeBrowser }, undefined, undefined, [], origin, origin);
  const api = async (path: string, method = "GET", body?: unknown) => {
    const r = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const parsed = await r.json().catch(() => ({})) as any;
    expect(r.ok, `${method} ${path} ${JSON.stringify(parsed)}`).toBe(true);
    return parsed;
  };
  let approvals = 0;
  // Computer tools always ask first; allow each card and keep waiting.
  const wait = async (botId: string, threadId: string): Promise<any> => {
    for (;;) {
      const state = await runControlOmb(["wait", "--bot", botId, "--task", threadId, "--timeout", "40"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
      if (state.status !== "needs-user") return state;
      const card = ((await api(`/api/threads/${threadId}/messages`)).messages as any[]).find((item) => item.card?.requestId && !item.card.answered)?.card;
      if (!card) return state;
      approvals++;
      await api(`/api/bots/${botId}/respond`, "POST", { threadId, requestId: card.requestId, behavior: "allow" });
    }
  };
  try {
    const { bot } = await api("/api/bots", "POST", { name: "Computer fixture" });
    await api(`/api/bots/${bot.id}`, "PATCH", { computer: "cloud", cloudBackend: "box", autoApprove: true });
    await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Look at the screen and run the check.", threadId: bot.threadId });
    // G (computer): nothing reaches the Box until the person allows it
    await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "40"], { env: { OPENMAUSBOT_URL: fixture.info.url } });
    expect(commands.filter((item) => item.command.includes(MARKER) || /ogb-panel/.test(item.command))).toHaveLength(0);
    const settled = await wait(bot.id, bot.threadId);
    expect(approvals).toBeGreaterThanOrEqual(2);
    expect(settled.status, JSON.stringify(settled).slice(0, 2000)).toBe("settled");

    // J: computer tools mounted into the NATION API turn
    const first = modelRequests[0];
    expect(first.tools).toEqual(expect.arrayContaining(["computer_screenshot", "computer_execute"]));
    // M: the model stayed NATION API; attaching a computer did not switch it
    expect(new Set(modelRequests.map((item) => item.auth))).toEqual(new Set(["Bearer nation_fixture_key_only"]));
    // K: the screenshot reached the model as image content
    const sawImage = modelRequests.some((request) => request.messages.some((item: any) =>
      item.role === "user" && Array.isArray(item.content)
        && item.content.some((part: any) => part.type === "image_url" && String(part.image_url?.url).startsWith("data:image/"))));
    expect(sawImage).toBe(true);
    // the shell command ran on this bot's own Box
    const ran = commands.filter((item) => item.command.includes(MARKER));
    expect(ran).toHaveLength(1);
    expect(boxes.map((item) => item.id)).toContain(ran[0].box);
    const transcript = (await api(`/api/threads/${bot.threadId}/messages`)).messages as any[];
    expect(transcript.filter((item) => item.kind === "activity").map((item) => item.tool?.name).join("\n")).toMatch(/screenshot|execute/i);

    // L: a person takes the computer; the agent's input is refused before the Box
    await api(`/api/bots/${bot.id}/computer/control`, "POST", { action: "take" });
    script = "exec";
    const before = modelRequests.length;
    await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Run the check again.", threadId: bot.threadId });
    const heldTurn = await wait(bot.id, bot.threadId);
    // Refused, reported as a failed tool call, and never claimed as done.
    expect(heldTurn.status, JSON.stringify(heldTurn.messages?.slice(-6))).toBe("failed");
    expect(JSON.stringify(heldTurn.messages)).toContain("the final response is not an execution receipt");
    expect(commands.filter((item) => item.command.includes(MARKER))).toHaveLength(1);
    const held = modelRequests.slice(before).flatMap((request) => request.messages).filter((item: any) => item.role === "tool").map((item: any) => item.content).join("\n");
    expect(held).toMatch(/control|person|human|taken/i);
    await api(`/api/bots/${bot.id}/computer/control`, "POST", { action: "release" });

    // released: the agent works again
    await api(`/api/bots/${bot.id}/messages`, "POST", { text: "Run the check one more time.", threadId: bot.threadId });
    expect((await wait(bot.id, bot.threadId)).status).toBe("settled");
    expect(commands.filter((item) => item.command.includes(MARKER))).toHaveLength(2);

    // I: browser tools mount into a NATION API turn for a browser-only bot
    await api("/api/config", "PATCH", { features: { browser: true } });
    const { bot: browserBot } = await api("/api/bots", "POST", { name: "Browser fixture" });
    await api(`/api/bots/${browserBot.id}`, "PATCH", { computer: "browser", browser: true });
    script = "browser";
    const browserStart = modelRequests.length;
    await api(`/api/bots/${browserBot.id}/messages`, "POST", { text: "Open the example page.", threadId: browserBot.threadId });
    expect((await wait(browserBot.id, browserBot.threadId)).status).toBe("settled");
    const browserTurn = modelRequests[browserStart];
    expect(browserTurn.tools).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot"]));
    expect(browserTurn.tools.some((name) => name.startsWith("computer_"))).toBe(false);
    expect(modelRequests.slice(browserStart).some((request) => request.messages.some((item: any) =>
      item.role === "tool" && String(item.content).includes("fixture browser navigate ok")))).toBe(true);

    // N: the Box token never reaches the model or the log
    expect(JSON.stringify(modelRequests)).not.toContain("box_verification_fixture");
    expect(readFileSync(fixture.info.logPath, "utf8")).not.toContain("box_verification_fixture");
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 150_000);
