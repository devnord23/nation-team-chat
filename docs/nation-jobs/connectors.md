# Connected apps, agent computers and model routing

## Connected apps (Plugins)

NATION operates one backend connected-apps project. Members never see or
enter its credential; they only authorize their own accounts (Connect Gmail,
Connect GitHub, Connect Notion) through the provider's OAuth page.

- **Backend (operator, once):** set `COMPOSIO_API_KEY` on the API process, or
  save the project key at `/admin` under Apps & computers. The key is
  write-only and never returned by any API.
- **Per account:** in a hosted workspace (NATION API credits or a hosted
  sign-in), every verified NATION account gets its own derived provider user
  id and its own Session. A member's inventory, OAuth links, disconnects and
  tool calls use only that account. The operator keeps the installation's own
  identity. The managed single-installation broker is never used for a member,
  because it has no per-user dimension; with only a broker configured, members
  see "not available in this workspace".
- **Turns:** the account a turn is billed to is the account whose connected
  apps it may use, fixed when its tools mount. A message queued while its
  thread was busy runs as its own sender; a batch mixing members gets no
  connected apps.
- **Per bot:** the bot's Connected apps switch (owner-only, Access settings)
  decides whether the tools mount at all. Every connector call goes through the
  normal approval flow.
- **Single-user installs** keep the upstream behaviour: one identity, managed
  by the owner; paired client devices cannot manage it.

Plugins shows, for each person: backend unavailable, unreachable, sign-in
needed, and per app not connected, waiting for sign-in, connected, or sign-in
expired (Reconnect). A healthy backend with nothing connected shows Connect.

## Agent computers

NATION API remains the model and billing authority when a bot has a Box, VPS or
browser. Box tools (screenshot, execute) are mounted into the NATION API turn
over the existing Box APIs with a per-turn control lease; while a person holds
the computer, calls are refused before they reach the Box. Screenshots reach the
model as image content, bounded to 32 MiB of encoded images per turn.

## Model routing

Each hosted turn is classified deterministically (fast, standard, strong) and
uses that tier's model from the operator's allowed catalog:

    NATION_MODEL_FAST=openai/gpt-4o-mini
    NATION_MODEL_STANDARD=openai/gpt-4.1
    NATION_MODEL_STRONG=openai/o4-mini

Unset tiers fall back to the next cheaper one and finally to
`NATION_OPENROUTER_MODEL` / the NATION default, so an unconfigured server uses
one model as before. If the provider rejects the routed model itself, the turn
retries once on the next cheaper allowed model (never for billing, quota or
context refusals). Decisions are recorded in `model-routes.jsonl` in the data
directory and at the admin-only `GET /api/admin/model-routing`.

## Verification

- `server/nation-member-connectors.e2e.test.ts`: two signed-in members, OAuth
  pending to connected, account-scoped inventory, approval before execution,
  result reaches the model and the answer, queued-message sender identity,
  bot opt-out, per-member billing, routing tiers, no credential leakage.
- `server/nation-connectors.e2e.test.ts`: operator path through the broker.
- `server/nation-computer.e2e.test.ts`: NATION API with Box computer and
  browser tools, screenshots to the model, human control, billing authority.
- `server/composio-principal.test.ts`, `server/nation-model-router.test.ts`,
  `server/drivers/openai-chat-tools.test.ts`: unit coverage.
