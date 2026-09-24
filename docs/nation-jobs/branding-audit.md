# Branding review — draft, blocked

The strict release guard currently FAILS. Do not merge or deploy this draft as a
completed zero-fingerprint scrub. The final frontend scan found 917 matches in
381 text assets. Baseline: 1,149 matches. Remaining matches include public
provider configuration code, dependency code and syntax grammars; the source
also contains legacy compatibility names and provider adapters.

The requested whole-source zero count conflicts with readable legacy environment
and data-directory fallbacks and with the guard's own forbidden-term list. These
strings have not been encoded or hidden to manufacture a passing search.

Implemented: full NATION face frames on avatar/picker/tour surfaces, base-aware
About logo, explicit bot introduction, canonical discovery path, renamed mascot
types/CSS, NATION_DATA_DIR precedence, old data reused in place, selected NATION
runtime environment aliases, strict build/CI asset guard, and draft-branch
automatic deployment disabled. LICENSE and NOTICE are unchanged.

Verification: TypeScript checks, Vite build, focused avatar/data compatibility
unit checks and an isolated fake-engine API fixture. The fixture proves bot
creation, member API privacy and a first-message two-bot team reply. It does not
prove the live VPS, all browser routes, or a complete absence of public vendor
strings. Full test suite was not rerun.

Required follow-up before release: move all provider/admin implementation out of
the public asset graph, audit remaining dependencies and protocols, complete all
legacy environment aliases, and rerun the strict guard against frontend plus
captured member API traffic. No broad allowlist was added.
