import { expect, it } from "vitest";
import { highlightCode } from "./code-highlight";

it.each(["js", "ts", "tsx", "jsx", "json", "css", "html", "py", "bash", "sql", "yml", "md"])("highlights %s with both NATION palettes", async language => {
  const html = await highlightCode('const sample = "hello";', language);
  expect(html).toContain("shiki-themes nation-light nation-dark");
  expect(html).toContain("light-dark(");
  expect(html).toContain("sample");
});
it("escapes unknown-language source without losing its content", async () => {
  const html = await highlightCode('<script>alert("sample")</script>', "unknown-language");
  expect(html).not.toContain("<script>");
  expect(html).toMatch(/(?:&lt;|&#x3c;|&#60;)script/i);
  expect(html).toContain("sample");
});
