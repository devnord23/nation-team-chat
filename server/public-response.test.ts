import { describe, expect, it } from "vitest";
import { publicResponse } from "./public-response.ts";
import { publicError } from "../shared/public-error.ts";

describe("NATION public projections", () => {
  it("redacts private routing in nested HTTP and stream payloads without mutating storage", () => {
    const data = { kind: "bot", bot: { modelSelection: { instanceId: "hermes", model: "openrouter/auto" },
      tasks: [{ lastInstanceId: "hermes", lastModel: "vendor/private", modelSelection: { instanceId: "hermes", model: "openrouter/auto" } }] } };
    const projected = JSON.stringify(publicResponse(data));
    expect(projected).toContain("NATION API");
    expect(projected).not.toMatch(/hermes|openrouter|vendor\/private/);
    expect(data.bot.modelSelection.model).toBe("openrouter/auto");
    expect(publicResponse(data, true)).toEqual(data);
  });

  it.each([
    "/root/.openmausbot/brand.json is not licensed for whitelabel",
    "Claude failed on server.private.example",
    "Error: model openrouter/auto failed\n at run (/tmp/app.ts:4:2)",
    "ENOENT C:\\Users\\Owner\\config.json",
  ])("does not publish diagnostic detail: %s", message => {
    expect(publicError(message)).toMatch(/^NATION/);
    expect(publicResponse({ tool: { name: message, ok: false, output: message } })).toEqual({
      tool: { name: publicError(message), ok: false, output: publicError(message) },
    });
  });

  it("keeps ordinary validation and user work intact", () => {
    expect(publicError("Choose a team name")).toBe("Choose a team name");
    const message = { role: "user", text: "Compare providers in my report" };
    expect(publicResponse(message)).toEqual(message);
  });
});


it("removes raw provider envelopes and private variants from live or replayed runtime events", () => {
  const event = { type: "session.model-variants", provider: "hermesAgent", providerInstanceId: "hermes", model: "openrouter/auto", sessionId: "native-session", variants: { options: [{ id: "vendor-model", label: "Claude" }] }, raw: { source: "hermes.acp", payload: { private: "diagnostic" } } };
  expect(publicResponse(event)).toEqual({ type: "session.model-variants", provider: "NATION API", providerInstanceId: "nation", model: "NATION API", variants: { options: [] } });
  expect(publicResponse({ ...event, type: "runtime.error", message: "Hermes failed at /srv/app/config.json" })).toMatchObject({ message: expect.stringMatching(/^NATION/) });
});


it("removes nested host paths and desk implementation details from member responses", () => {
  const input = { bot: { tasks: [{ cwd: "/root/.openmausbot/task-workspaces/private", threadId: "task" }] },
    backend: "vps", ready: true, sshAlias: "private-host", image_ref: "old-image", container_name: "private-container" };
  expect(publicResponse(input)).toEqual({ bot: { tasks: [{ threadId: "task" }] }, backend: "vps", ready: true });
  expect(publicResponse(input, true)).toEqual(input);
});

it("canonicalizes historical links and schedule destinations without rewriting stored records", () => {
  const original = { text: "See [work](openmausbot://thread/abc?bot=one)", runOn: "maus", format: "openmaus.backup" };
  expect(publicResponse(original)).toEqual({ text: "See [work](nation://thread/abc?bot=one)", runOn: "nation", format: "nation.backup" });
  expect(original.runOn).toBe("maus");
  expect(original.text).toContain("openmausbot:");
});
