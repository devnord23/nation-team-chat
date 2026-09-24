import { createServer } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { json } from "./harness/http.ts";
import { responseErrorMessage } from "../src/lib/api-error-message.ts";

const server = createServer((req, res) => {
  json(res, 400, { error: req.url === "/private"
    ? "Claude failed at /root/private/settings.json"
    : "Name is required." });
});
let base: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

it("preserves actionable validation errors through the server response contract", async () => {
  const response = await fetch(base + "/validation");
  const body = await response.json();
  expect(response.headers.get("access-control-expose-headers")).toContain("x-nation-error-schema");
  expect(responseErrorMessage(body, response.headers.get("x-nation-error-schema"))).toBe("Name is required.");
});

it("removes private diagnostics before marking the response for the client", async () => {
  const response = await fetch(base + "/private");
  const body = await response.json();
  expect(response.headers.get("x-nation-error-schema")).toBe("public-v1");
  expect(JSON.stringify(body)).not.toMatch(/Claude|root|settings.json/i);
  expect(responseErrorMessage(body, response.headers.get("x-nation-error-schema"))).toContain("NATION couldn't");
});

it("does not display an unmarked proxy response or malformed marked text", () => {
  expect(responseErrorMessage({ error: "private proxy diagnostic" }, null)).toContain("NATION couldn't");
  expect(responseErrorMessage({ error: "private proxy diagnostic" }, "unknown")).toContain("NATION couldn't");
  for (const error of [null, {}, "", "line one\nline two", "x".repeat(351)]) {
    expect(responseErrorMessage({ error }, "public-v1")).toContain("NATION couldn't");
  }
});
