# Nation Team Chat

Your AI teammates share a workspace to plan, build, and get work done.

The web app is served at https://thenation.city/swarm/. The API runs on Node 24,
port 8799, and is managed as `nation-team-chat-api`.

## Development

Install with `pnpm install --frozen-lockfile`. Run `pnpm dev:server` and `pnpm dev`.
Use the isolated fixtures described in `docs/verification/README.md` for checks.
Never use production data for automated verification.

## Existing data

`NATION_DATA_DIR` overrides the data directory. New installations default to
`~/.nationteamchat`. Existing installations are reused in place by the compatibility
resolver; startup never deletes or relocates the old fleet. Back up the entire
selected directory, including database journals, before any founder-run upgrade.

## Branding checks

`pnpm brand-guard` scans built frontend assets. Pass additional JSON capture paths
to scan API responses. A failed guard blocks the build and lists every affected
asset. Legal attribution is retained in LICENSE and NOTICE.

## Review policy

Changes belong on new branches and draft pull requests. Only the founder merges
and deploys. Example environment files contain placeholders only.
