// Hosted NATION: two signed-in members share one bot. Each must get their
// own persistent isolated computer (and browser session) for that bot.
// Owned loopback stand-ins only: the NATION account service, the Box
// provider (with a per-machine filesystem), the NATION API model and a fake
// agent-browser. Proves:
//   1. Alice's file persists on her computer across turns and conversations;
//   2. Bob, on the same bot, gets a different computer and cannot see it;
//   3. Alice cannot see Bob's file;
//   4. one computer per (account, bot), never one per message;
//   5. browser sessions are per account too;
//   6. forged owner/admin/proxy/companion values change nothing;
//   7. no cross-member billing or computer attribution;
//   8. members cannot reach the install's computer routes.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const BOX_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

it("each member gets their own persistent computer and browser for a shared bot", async () => {
  const boxes: Array<{ id: string; name: string; state: string; files: Map<string, string> }> = [];
  const commands: Array<{ box: string; command: string }> = [];
  const modelRequests: Array<{ tools: string[]; body: any }> = [];
  let callSeq = 0;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const path = url.pathname;
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    // NATION account service
    if (path === "/api/auth/email-otp/send-verification-otp") return json({ status: true });
    if (path === "/api/auth/sign-in/email-otp") {
      return json({ user: { id: "acct_" + body.email.split("@")[0], email: body.email } }, 200, { "set-auth-token": "fixture_" + randomBytes(12).toString("hex") });
    }
    if (path === "/api/auth/sign-out") return json({ success: true });
    if (path.startsWith("/api/v3")) return json({ items: [] });
    // NATION API model: runs the command the person named, then reports.
    if (path.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      modelRequests.push({ tools, body });
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user" && typeof item.content === "string");
      const ask = String(lastUser?.content ?? "").trim().split("\n").at(-1) ?? "";
      const replies = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1).filter((item: any) => item.role === "tool");
      const save = ask.match(/^save (\S+) as (\S+)$/);
      const show = ask.match(/^show (\S+)$/);
      const command = save ? `printf %s ${save[1]} > /root/${save[2]}` : show ? `cat /root/${show[1]}` : /^list files$/.test(ask) ? "ls /root" : "";
      const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `c-${++callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
      const delta = command && replies.length === 0 && tools.includes("computer_execute")
        ? call("computer_execute", { command })
        : /^browse$/.test(ask) && replies.length === 0 && tools.includes("browser_navigate")
          ? call("browser_navigate", { url: "https://example.test/" })
          : { content: `Result: ${replies.map((item: any) => JSON.parse(item.content).result).join(" | ") || "none"}` };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.002 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    // Box provider: each machine has its own filesystem.
    if (req.headers.authorization !== "Bearer box_verification_fixture") return json({ ok: false, code: "unauthorized" }, 401);
    if (path === "/boxes" && req.method === "GET") return json({ ok: true, boxes: boxes.map(({ files: _files, ...box }) => box) });
    if (path === "/boxes" && req.method === "POST") {
      const id = "bx_" + Array.from({ length: 8 }, (_, i) => BOX_ALPHABET[(boxes.length * 7 + i * 3) % BOX_ALPHABET.length]).join("");
      const box = { id, name: body.name ?? "", state: "running", files: new Map<string, string>() };
      boxes.push(box);
      const { files: _files, ...wire } = box;
      return json({ ok: true, box: wire }, 201);
    }
    let m = path.match(/^\/boxes\/(bx_\w{8})$/);
    if (m) {
      const box = boxes.find((item) => item.id === m![1]);
      if (!box) return json({ ok: false, message: "not found" }, 404);
      if (req.method === "PATCH" && body.name) box.name = body.name;
      const { files: _files, ...wire } = box;
      return json({ ok: true, box: wire });
    }
    m = path.match(/^\/boxes\/(bx_\w{8})\/commands$/);
    if (m) {
      const box = boxes.find((item) => item.id === m![1])!;
      const text = String(body.command);
      commands.push({ box: box.id, command: text });
      const write = text.match(/printf %s (\S+) > \/root\/([\w.-]+)/);
      const read = text.match(/cat \/root\/([\w.-]+)/);
      if (write) { box.files.set(write[2], write[1]); return json({ ok: true, exitCode: 0, stdout: "", stderr: "" }); }
      if (read) {
        const content = box.files.get(read[1]);
        return content === undefined
          ? json({ ok: true, exitCode: 1, stdout: "", stderr: `cat: /root/${read[1]}: No such file or directory` })
          : json({ ok: true, exitCode: 0, stdout: content, stderr: "" });
      }
      if (/ls \/root/.test(text)) return json({ ok: true, exitCode: 0, stdout: [...box.files.keys()].join("\n"), stderr: "" });
      return json({ ok: true, exitCode: 0, stdout: /ogb-panel/.test(text) ? "captured" : "", stderr: "" });
    }
    if (/^\/boxes\/bx_\w{8}\/(artifacts|files|desktop|resume|stop)$/.test(path)) return json({ ok: true, content: "", desktopUrl: "https://desktop.invalid/" });
    json({ ok: true });
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fakeBrowser = fileURLToPath(new URL("./testing/fake-agent-browser.mjs", import.meta.url));
  const fixture = await launchVerificationServer(process.env, undefined, undefined, { binaryPath: fakeBrowser, executablePath: fakeBrowser },
    undefined, undefined, [], origin, origin, undefined, { providerApi: origin, memberEmails: [ALICE, BOB] });
  const request = async (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {}, headers: response.headers };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const r = await request(path, { method, body });
    expect(r.status, `${method} ${path} ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  const signIn = async (email: string) => {
    await request("/api/auth/email/start", { method: "POST", body: { email } });
    const verified = await request("/api/auth/email/verify", { method: "POST", body: { email, code: "12345678", label: email } });
    return String(verified.headers.get("set-cookie")).split(";")[0];
  };
  const forged = {
    "x-openmausbot-desktop-owner": "1", "x-openmausbot-companion": "1", "x-openmausbot-companion-auth": "forged",
    "x-openmausbot-companion-device": "forged-device", "x-forwarded-for": "127.0.0.1", "x-nation-admin": "1",
  };
  try {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    const accountId = (email: string) => "email:" + createHash("sha256").update(email).digest("hex");
    for (const [cookie, email] of [[alice, ALICE], [bob, BOB]]) {
      await request("/api/credits/status", { cookie });
      await owner("/api/admin/credits/adjust", "POST", { userId: accountId(email), amountUsd: 5, reason: "fixture credit" });
    }
    const balance = async (cookie: string) => (await request("/api/credits/status", { cookie })).body.balanceUsd as number;
    await owner("/api/config", "PATCH", { features: { browser: true } });
    const { bot } = await owner("/api/bots", "POST", { name: "Shared worker" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "cloud", cloudBackend: "box", composio: false, autoApprove: false });
    const thread = async (cookie: string, title: string, botId = bot.id) => (await request(`/api/bots/${botId}/tasks`, { method: "POST", body: { title }, cookie })).body.task.threadId as string;
    const settle = async (botId: string, threadId: string, cookie: string) => {
      for (;;) {
        const state = await runControlOmb(["wait", "--bot", botId, "--task", threadId, "--timeout", "30"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
        if (state.status !== "needs-user") return state;
        const open = ((await request(`/api/threads/${threadId}/messages`, { cookie })).body.messages as any[]).find((item) => item.card?.requestId && !item.card.answered)?.card;
        if (!open) return state;
        await request(`/api/bots/${botId}/respond`, { method: "POST", body: { threadId, requestId: open.requestId, behavior: "allow" }, cookie });
      }
    };
    const ask = async (cookie: string, threadId: string, text: string, botId = bot.id, headers?: Record<string, string>) => {
      const before = commands.length;
      const sent = await request(`/api/bots/${botId}/messages`, { method: "POST", body: { text, threadId }, cookie, headers });
      expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
      const state = await settle(botId, threadId, cookie);
      expect(state.status, JSON.stringify(state.messages?.slice(-3))).toMatch(/settled|failed/);
      const reply = ((await request(`/api/threads/${threadId}/messages`, { cookie })).body.messages as any[]).filter((item) => item.role === "bot" && item.kind === "text").at(-1)?.text ?? "";
      return { reply, boxes: [...new Set(commands.slice(before).filter((item) => /printf|cat \/root|ls \/root/.test(item.command)).map((item) => item.box))] };
    };

    // 1. Alice writes a file on her computer.
    const aliceThread = await thread(alice, "Alice work");
    const aliceBefore = await balance(alice);
    const bobIdle = await balance(bob);
    const aliceSave = await ask(alice, aliceThread, "save ALICE-7f3 as alice.txt");
    expect(aliceSave.boxes).toHaveLength(1);
    const aliceBox = aliceSave.boxes[0];
    expect(await balance(alice)).toBeLessThan(aliceBefore);
    expect(await balance(bob)).toBe(bobIdle); // Alice's work is never billed to Bob
    // 2. ...and sees it again in a later turn and in a new conversation.
    expect((await ask(alice, aliceThread, "show alice.txt")).reply).toContain("ALICE-7f3");
    const aliceLater = await thread(alice, "Alice later");
    const again = await ask(alice, aliceLater, "show alice.txt");
    expect(again.reply).toContain("ALICE-7f3");
    expect(again.boxes).toEqual([aliceBox]);

    // 3. Bob, same bot, his own conversation: a different computer, no Alice file.
    const bobThread = await thread(bob, "Bob work");
    const aliceIdle = await balance(alice);
    const bobBefore = await balance(bob);
    const bobLooks = await ask(bob, bobThread, "show alice.txt");
    expect(bobLooks.reply).not.toContain("ALICE-7f3");
    expect(bobLooks.reply).toMatch(/No such file/);
    expect(bobLooks.boxes).toHaveLength(1);
    const bobBox = bobLooks.boxes[0];
    expect(bobBox).not.toBe(aliceBox);
    expect((await ask(bob, bobThread, "list files")).reply).not.toContain("alice.txt");
    // 5. Bob creates his own file; 6. Alice cannot see it.
    await ask(bob, bobThread, "save BOB-9c1 as bob.txt");
    expect((await ask(bob, bobThread, "show bob.txt")).reply).toContain("BOB-9c1");
    expect(await balance(bob)).toBeLessThan(bobBefore);
    expect(await balance(alice)).toBe(aliceIdle); // Bob's work is never billed to Alice
    const aliceLooks = await ask(alice, aliceThread, "show bob.txt");
    expect(aliceLooks.reply).not.toContain("BOB-9c1");
    expect(aliceLooks.boxes).toEqual([aliceBox]);
    expect((await ask(alice, aliceThread, "list files")).reply).not.toContain("bob.txt");

    // 7. Forged owner/admin/proxy/companion values change nothing.
    const forgedCookie = `${bob}; nation.adminUnlocked=1; nation_admin=1`;
    const forgedLook = await ask(forgedCookie, bobThread, "show alice.txt", bot.id, forged);
    expect(forgedLook.reply).not.toContain("ALICE-7f3");
    expect(forgedLook.boxes).toEqual([bobBox]);
    for (const [path, method, body] of [
      [`/api/bots/${bot.id}/computer/exec`, "POST", { command: "cat /root/alice.txt" }],
      [`/api/bots/${bot.id}/computer/control`, "POST", { action: "take" }],
      [`/api/bots/${bot.id}/computer`, "GET", undefined],
      ["/api/computers/boxes", "GET", undefined],
    ] as const) {
      for (const [who, init] of [["plain", { cookie: bob }], ["forged", { cookie: forgedCookie, headers: forged }]] as const) {
        expect.soft((await request(path, { method, body, ...init })).status, `Bob (${who}) ${method} ${path}`).toBe(403);
      }
    }

    // 4. Exactly one computer per member for this bot, never one per message,
    // and every command landed on its owner's machine only.
    const botBoxes = boxes.filter((item) => item.id === aliceBox || item.id === bobBox);
    expect(boxes).toHaveLength(2);
    expect(new Set(botBoxes.map((item) => item.name)).size).toBe(2);
    expect(boxes.find((item) => item.id === aliceBox)!.files.has("bob.txt")).toBe(false);
    expect(boxes.find((item) => item.id === bobBox)!.files.has("alice.txt")).toBe(false);

    // Browser sessions are per member, and stable for the same member.
    const { bot: browserBot } = await owner("/api/bots", "POST", { name: "Shared browser" });
    await owner(`/api/bots/${browserBot.id}`, "PATCH", { computer: "browser", browser: true, composio: false, autoApprove: false });
    const sessionOf = (reply: string) => reply.match(/session=([\w.-]+)/)?.[1];
    const aliceBrowse = sessionOf((await ask(alice, await thread(alice, "Alice browse", browserBot.id), "browse", browserBot.id)).reply);
    const aliceBrowseAgain = sessionOf((await ask(alice, await thread(alice, "Alice browse 2", browserBot.id), "browse", browserBot.id)).reply);
    const bobBrowse = sessionOf((await ask(bob, await thread(bob, "Bob browse", browserBot.id), "browse", browserBot.id)).reply);
    expect(aliceBrowse).toBeTruthy();
    expect(bobBrowse).toBeTruthy();
    expect(aliceBrowseAgain).toBe(aliceBrowse);
    expect(bobBrowse).not.toBe(aliceBrowse);
    // the bot's own (operator) session is neither of them, and members can't watch any live browser
    expect(aliceBrowse).not.toBe(`bot-${browserBot.id}`);
    expect(bobBrowse).not.toBe(`bot-${browserBot.id}`);
    for (const cookie of [alice, bob]) {
      expect((await request(`/api/bots/${browserBot.id}/browser/live`, { cookie, headers: forged })).status).toBe(403);
    }
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 240_000);
