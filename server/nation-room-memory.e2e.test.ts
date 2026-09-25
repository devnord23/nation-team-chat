// Hosted NATION room memory. Two members, one bot, two team rooms and
// private conversations; every external service is an owned loopback
// stand-in and the NATION API model saves memory when asked to.
// Proves:
//   - a room turn saves a unique note, and a later room turn recalls it;
//   - no private conversation (either member's) can recall it;
//   - room memory is the bot's team memory: another team room of the same
//     bot recalls it too. That is intentional: every member can already read
//     every team room, so a team note is team-visible by design;
//   - private account memory stays private: never in any room, never in the
//     other member's conversations;
//   - memory written before per-account scoping reaches no turn.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const ALICE = "alice.rooms@example.test";
const BOB = "bob.rooms@example.test";

it("room memory is recalled in team rooms and nowhere private", async () => {
  const modelRequests: Array<{ system: string }> = [];
  let callSeq = 0;
  const provider = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url!, "http://fixture");
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    if (url.pathname === "/api/auth/email-otp/send-verification-otp") return json({ status: true });
    if (url.pathname === "/api/auth/sign-in/email-otp") {
      return json({ user: { id: "acct_" + body.email.split("@")[0], email: body.email } }, 200, { "set-auth-token": "fixture_" + randomBytes(12).toString("hex") });
    }
    if (url.pathname === "/api/auth/sign-out") return json({ success: true });
    if (url.pathname.startsWith("/api/v3")) return json({ items: [] });
    if (url.pathname.endsWith("/chat/completions")) {
      const tools: string[] = (body.tools ?? []).map((item: any) => item.function.name);
      modelRequests.push({ system: JSON.stringify(body.messages.filter((item: any) => item.role === "system")) });
      const lastUser = [...body.messages].reverse().find((item: any) => item.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      const ask = text.trim().split("\n").filter((line: string) => line.trim() && !line.startsWith("(Reply to ")).at(-1) ?? "";
      const replies = body.messages.slice(body.messages.lastIndexOf(lastUser) + 1).filter((item: any) => item.role === "tool");
      const remember = ask.match(/\bremember (.+)$/i);
      const delta = remember && tools.includes("agents_memory_update") && replies.length === 0
        ? { tool_calls: [{ index: 0, id: `m-${++callSeq}`, type: "function", function: { name: "agents_memory_update", arguments: JSON.stringify({ action: "append", text: remember[1] }) } }] }
        : { content: replies.length ? `Saved: ${JSON.parse(replies[0].content).result}` : "Hello." };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: " + JSON.stringify({ choices: [{ delta, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }) + "\n\ndata: [DONE]\n\n");
      return;
    }
    json({ error: "not found" }, 404);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (provider.address() as { port: number }).port;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], undefined,
    origin, undefined, { providerApi: origin, memberEmails: [ALICE, BOB] });
  const request = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {}, text };
  };
  const owner = async (path: string, method = "GET", body?: unknown) => {
    const r = await request(path, { method, body });
    expect(r.status, `${method} ${path} ${r.text}`).toBeLessThan(300);
    return r.body;
  };
  const signIn = async (email: string) => {
    expect((await request("/api/auth/email/start", { method: "POST", body: { email } })).status).toBe(200);
    const response = await fetch(fixture.info.url + "/api/auth/email/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code: "12345678", label: email }) });
    return String(response.headers.get("set-cookie")).split(";")[0];
  };
  try {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    for (const [cookie, email] of [[alice, ALICE], [bob, BOB]]) {
      await request("/api/credits/status", { cookie });
      await owner("/api/admin/credits/adjust", "POST", { userId: "email:" + createHash("sha256").update(email).digest("hex"), amountUsd: 5, reason: "fixture credit" });
    }
    const { bot } = await owner("/api/bots", "POST", { name: "Scribe" });
    await owner(`/api/bots/${bot.id}`, "PATCH", { computer: "off", composio: false, autoApprove: true });
    // legacy namespace (before per-account scoping): must reach no turn
    await owner(`/api/bots/${bot.id}/memory`, "PUT", { text: "- Legacy note Heron-44" });

    // Waits for the target to settle, answering any approval card as `cookie`
    // on the conversation that carries it.
    const settle = async (target: string[], threads: string[], cookie: string, room?: boolean) => {
      for (let i = 0; i < 6; i++) {
        const state = await runControlOmb(["wait", ...target, "--timeout", "25"], { env: { OPENMAUSBOT_URL: fixture.info.url } }) as any;
        if (state.status !== "needs-user") return state;
        let answered = false;
        for (const threadId of new Set([...threads, state.taskId].filter(Boolean))) {
          const open = ((await request(`/api/threads/${threadId}/messages`, { cookie })).body.messages as any[] ?? []).find((item) => item.card?.requestId && !item.card.answered)?.card;
          if (!open) continue;
          const reply = room
            ? await request(`/api/threads/${threadId}/respond`, { method: "POST", body: { requestId: open.requestId, behavior: "allow" }, cookie })
            : await request(`/api/bots/${bot.id}/respond`, { method: "POST", body: { threadId, requestId: open.requestId, behavior: "allow" }, cookie });
          expect(reply.status, reply.text).toBeLessThan(300);
          answered = true;
        }
        if (!answered) return state;
      }
    };
    const roomTurn = async (room: any, text: string, cookie: string) => {
      const before = modelRequests.length;
      expect((await request(`/api/groups/${room.id}/messages`, { method: "POST", body: { text }, cookie })).status).toBeLessThan(300);
      await settle(["--channel", room.id], [room.threadId], cookie, true);
      return modelRequests.slice(before).map((item) => item.system).join("\n");
    };
    const privateTurn = async (thread: string, text: string, cookie: string) => {
      const before = modelRequests.length;
      expect((await request(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text, threadId: thread }, cookie })).status).toBeLessThan(300);
      await settle(["--bot", bot.id, "--task", thread], [thread], cookie);
      return modelRequests.slice(before).map((item) => item.system).join("\n");
    };
    const roomOne = (await request("/api/groups", { method: "POST", body: { name: "Standup", memberIds: [bot.id] }, cookie: alice })).body.group;
    const roomTwo = (await request("/api/groups", { method: "POST", body: { name: "Planning", memberIds: [bot.id] }, cookie: bob })).body.group;
    const aliceThread = (await request(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title: "Alice notes" }, cookie: alice })).body.task.threadId as string;
    const bobThread = (await request(`/api/bots/${bot.id}/tasks`, { method: "POST", body: { title: "Bob notes" }, cookie: bob })).body.task.threadId as string;

    // Room turn 1 saves a unique team note; a later room turn recalls it.
    await roomTurn(roomOne, "@everyone remember Team codename Osprey-3", bob);
    expect(await roomTurn(roomOne, "@everyone Say hello team", alice)).toContain("Osprey-3");
    // Another team room of the same bot shares the team note (by design).
    expect(await roomTurn(roomTwo, "@everyone Say hello planning", bob)).toContain("Osprey-3");
    // No private conversation recalls it.
    expect(await privateTurn(aliceThread, "Say hello", alice)).not.toContain("Osprey-3");
    expect(await privateTurn(bobThread, "Say hello", bob)).not.toContain("Osprey-3");

    // Private account memory stays with its account.
    await privateTurn(aliceThread, "remember Alice private codename Falcon-9", alice);
    expect(await privateTurn(aliceThread, "Say hello again", alice)).toContain("Falcon-9");
    expect(await privateTurn(bobThread, "Say hello again", bob)).not.toContain("Falcon-9");
    expect(await roomTurn(roomOne, "@everyone Say hello once more", alice)).not.toContain("Falcon-9");
    expect(await roomTurn(roomTwo, "@everyone Say hello once more", bob)).not.toContain("Falcon-9");

    // Legacy memory reached no turn at all; the operator can still review it.
    expect(modelRequests.some((item) => item.system.includes("Heron-44"))).toBe(false);
    expect(JSON.stringify(await owner(`/api/bots/${bot.id}/memory`))).toContain("Heron-44");
    // Members cannot read any memory namespace directly.
    expect((await request(`/api/bots/${bot.id}/memory`, { cookie: bob })).status).toBe(403);
  } finally {
    await fixture.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
}, 180_000);
