# Branding review — public build passes; launch verification pending

## Exact candidate and evidence

The combined PR #10 candidate `d8fab572acd9fa21795b7490387c906410ca4abc`
includes PR #8 branding, PR #9 connector removal, and credit billing.
Independent verification on 2026-09-24 in an isolated VPS checkout:

- `pnpm install --frozen-lockfile --ignore-scripts`: passed.
- `pnpm build`: both TypeScript checks, Vite build and strict guard passed.
- Public assets: **88 files, zero matches**.
- Assets plus captured regular-member API responses: **89 files, zero matches**.
- Final ledger/payment, real HTTP credit flow and real HTTP web protocol checks:
  **18 tests across 3 files passed**, 7.77 seconds.

Logs are retained in `/tmp/nation-branding-verification.Dje3AK`:
`final-install.log`, `final-build.log`, `final-billing-tests.log`,
and `final-member-api.json`. No live data or credentials were used.

## Implementation

The approved web launch uses NATION API only. Provider setup, keys, legacy model
pickers and inactive connector hints are absent from the public web graph.
Owner billing controls remain. Hosted voice and avatar controls use server
configuration. Brand faces and local icons remain, including validated custom
uploads. Syntax highlighting loads an explicit small grammar set.

Legacy formats, scheduler destinations and thread links are translated at the
server boundary; stored data and old import compatibility are preserved.
Team import previews reuse the existing server parser. Public error responses
are sanitized by the server before the client displays them.

Seven pinned dependency patches change user-visible diagnostic/support strings
and one layout description. They do not change rendering algorithms or license
notices. The large ELK patch is caused by the upstream single-line minified
distribution. The frozen lockfile includes every patch hash. No post-build
rewriting, encoded substitutions or broad guard allowlists were used.
LICENSE and NOTICE remain intact.

## Earlier focused checks

During implementation, independent runs passed: 40 workspace/preferences/peer
checks, 61 protocol/import/redaction checks, 20 integrated web/ledger checks,
and repeated isolated credit and web protocol HTTP fixtures. These overlap;
they are not an aggregate full-suite count. The final exact-candidate evidence
above supersedes old asset counts.

## Compatibility and release limits

Browser sidebar/layout and local voice preferences now use the NATION namespace.
An existing browser may initially show default layout/voice preferences; encrypted
workspace backup imports translate the supported old preference keys. Financial
balances and payment replay protection remain excluded from workspace rollback.

A whole-repository zero-text count is not claimed. Readable legacy environment
and data compatibility aliases, source-only adapters, historical docs, dependency
metadata and the guard's own forbidden-term list remain in source. Public assets
and captured regular-member API responses are the measured release boundary.

Browser verification, approved desktop wallpaper evidence, live authenticated
smoke and founder review remain pending. This build result is not a deployment
or live-payment result. PRs remain drafts and production is unchanged.

## Brave verification and corrections

On the user's PC, the isolated built app was checked in a separate Brave window.
The check exposed a voice tooltip asking for an unsupported provider key and an
owner-routing bypass. Both were corrected on GitHub:

- `1647c65b`: neutral unavailable-voice wording in all ten catalogs, shared tooltip
  no longer branches on a provider. Full build passed again: 88 assets, zero hits.
- `dcea19e5`: owner/admin exemption affects credit deduction, while managed turns
  still use NATION API. The real HTTP fixture now asserts an owner turn reaches
  the mock API and records $2.30 cost with zero credit deduction.

On `dcea19e5`, all 18 ledger/payment and HTTP checks passed in 7.87 seconds.
TypeScript passed; updated public assets plus member API capture passed with
89 files / zero matches. The browser used those assets with this server commit.

Brave checks passed for welcome dismissal, chat submission, NATION API response,
lazy JavaScript highlighting, Mermaid flowchart rendering, hosted settings
without provider/connector setup, neutral voice-unavailable text, and retained
owner API/Credits navigation. The owner credit page displayed $0.100000 mock
provider cost and $0 credit sold. A read-only SQLite check confirmed exactly
100000 cost microdollars and zero deduction for that browser-triggered turn.
Evidence: `owner-route-tests.log`, `owner-route-types.log`,
`browser-fix-build.log`, `owner-fixed-member-api.json`, and
`brave-owner-evidence.json` in the verification evidence directory.

This covers the listed browser flows, not every route, live token purchase,
member wallet-extension signing, generated avatar appearance or the managed
desktop wallpaper. GitHub currently exposes no check runs for this draft head;
the passing results above are the independently executed VPS checks.
