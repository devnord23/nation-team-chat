import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("previews and imports canonical teams and accepts both scheduler destination formats", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, ["hermes"]);
  const call = async (path: string, method = "GET", body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    await call("/api/config", "PUT", { defaultModelSelection: { instanceId: "hermes", model: "openrouter/auto" } });
    const before = (await call("/api/bots")).body;
    const manifest = { format: "nation.team", version: 2, team: { name: "Preview team", members: [{ name: "Scout", title: "Research" }] } };
    const preview = await call("/api/teams/import-preview", "POST", { manifest });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body).toMatchObject({ kind: "team", name: "Preview team", manifest: { format: "nation.team" } });
    expect((await call("/api/bots")).body).toEqual(before);
    expect((await call("/api/teams/import-preview", "POST", { manifest: { ...manifest, version: 99 } })).status).toBe(400);
    const imported = await call("/api/teams/import", "POST", preview.body.manifest);
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    const bot = imported.body.bots[0];
    expect(bot.name).toBe("Scout");
    const routine = await call("/api/routines", "POST", {
      name: "Canonical schedule", botId: bot.id, prompt: "Say hello", runOn: "nation",
      enabled: false, schedule: { type: "once", at: Date.now() + 3_600_000 }, durationMinutes: 5,
    });
    expect(routine.status, JSON.stringify(routine.body)).toBe(201);
    expect(routine.body.routine.runOn).toBe("nation");
    const changed = await call(`/api/routines/${routine.body.routine.id}`, "PATCH", { runOn: "maus" });
    expect(changed.status).toBe(200);
    expect(changed.body.routine.runOn).toBe("nation");
    const hook = await call("/api/webhooks", "POST", { name: "Canonical webhook", botId: bot.id, prompt: "Say hello", runOn: "nation", enabled: false });
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    expect(hook.body.webhook.runOn).toBe("nation");
    const pairing = await call("/api/auth/pairing", "POST", { scopes: ["client"], label: "Read-only fixture" });
    const paired = await call("/api/pair", "POST", { code: pairing.body.code, deviceName: "Read-only fixture" });
    const token = paired.body.token;
    expect(token).toBeTruthy();
    expect((await call("/api/teams/import-preview", "POST", { manifest }, token)).status).toBe(403);
    expect((await call("/api/routines", "GET", undefined, token)).body.routines[0].runOn).toBe("nation");
  } finally {
    await fixture.close();
  }
}, 60_000);
