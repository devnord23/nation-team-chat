import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { ThemeRegistration } from "shiki/types";

// Explicit grammar imports keep unused language/theme catalogs out of public assets.
// Other fences still render their complete source as escaped, copyable plain text.
const languages = {
  javascript: () => import("@shikijs/langs/javascript"),
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  css: () => import("@shikijs/langs/css"),
  html: () => import("@shikijs/langs/html"),
  python: () => import("@shikijs/langs/python"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  sql: () => import("@shikijs/langs/sql"),
  yaml: () => import("@shikijs/langs/yaml"),
  markdown: () => import("@shikijs/langs/markdown"),
};
const aliases: Record<string, string> = {
  js: "javascript", ts: "typescript", py: "python", sh: "shellscript",
  bash: "shellscript", shell: "shellscript", yml: "yaml", md: "markdown",
};
function palette(dark: boolean): ThemeRegistration {
  return {
    name: dark ? "nation-dark" : "nation-light", type: dark ? "dark" : "light",
    colors: { "editor.background": dark ? "#17191c" : "#f7f8fa", "editor.foreground": dark ? "#e7eaf0" : "#242a35" },
    tokenColors: [
      { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: dark ? "#98a4b5" : "#56677d" } },
      { scope: ["keyword", "storage"], settings: { foreground: dark ? "#c8b4ff" : "#6442a6" } },
      { scope: ["string"], settings: { foreground: dark ? "#9fd5be" : "#28654e" } },
      { scope: ["constant", "support", "entity.name.function"], settings: { foreground: dark ? "#9ac9ef" : "#2c5d83" } },
    ],
  };
}
let instance: ReturnType<typeof createHighlighterCore> | undefined;
function highlighter() {
  return instance ??= createHighlighterCore({
    themes: [palette(false), palette(true)], langs: [],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  }).catch(error => { instance = undefined; throw error; });
}
export async function highlightCode(code: string, language: string): Promise<string> {
  const input = language.trim().toLowerCase();
  const name = aliases[input] ?? input;
  const supported = Object.hasOwn(languages, name);
  const renderer = await highlighter();
  if (supported && !renderer.getLoadedLanguages().includes(name)) {
    await renderer.loadLanguage(languages[name as keyof typeof languages]());
  }
  return renderer.codeToHtml(code, {
    lang: supported ? name : "text",
    themes: { light: "nation-light", dark: "nation-dark" },
    defaultColor: "light-dark()",
  });
}
