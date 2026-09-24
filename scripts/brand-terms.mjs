// Intentionally readable: a guard must not conceal the terms it checks.
const banned = /openmuse|open muse|open-muse|open_muse|openmaus(?:bot)?|maus|open source|opensource|github|star us|contribute|anthropic|claude|hermes|nous|venice|grok|xai|cua/gi;
const shortNames = new Set(["maus", "nous", "grok", "xai", "cua"]);
export function brandHits(text) {
  return [...text.matchAll(banned)].filter(hit => {
    if (!shortNames.has(hit[0].toLowerCase())) return true;
    const before = text[hit.index - 1] ?? "";
    const after = text[hit.index + hit[0].length] ?? "";
    // Preserve delimited names and camel-case identifiers such as xaiApiKey,
    // but do not identify "nous" inside "asynchronous" as a provider.
    const start = !/[a-z0-9]/i.test(before)
      || (/[a-z]/.test(before) && /^[A-Z]/.test(hit[0]));
    const end = !/[a-z0-9]/i.test(after)
      || (/[a-z]$/.test(hit[0]) && /^[A-Z]/.test(after));
    return start && end;
  });
}
