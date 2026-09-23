# NATION Team Chat

> Your own team of AI bots, in a chat app.
> Persistent, named AI teammates that share one durable computer.
> Every consequential action asks you first.

## Layout

```
┌──────────────┬────────────────────┬──────────────────┐
│  Bot Roster  │   Chat (DM/Team)   │ Shared Computer  │
│              │                    │ + Approvals Inbox │
│  Named bots  │   Messages, tools  │                  │
│  Group chats │   Ask-first cards  │  Live screen     │
│  Teams       │   File attachments │  Take control    │
└──────────────┴────────────────────┴──────────────────┘
```

**Left**: named bot roster with status indicators, group chats, and team sections.
**Center**: chat view (DM with a single bot or multi-bot group conversation).
**Right**: shared computer panel with live screen preview and approval cards.

## Quick Start

```bash
# Prerequisites: Node.js >= 22, pnpm 10+
corepack enable
pnpm install

# Start the backend server (runs AI engines)
pnpm dev:server

# In another terminal, start the web UI
pnpm dev
# → opens at http://localhost:5199
```

The web UI connects to the local bot server on port 8799 via `/api` proxy.

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|---|---|---|
| `OMB_BIND_ADDRESS` | `127.0.0.1` | Server bind address |
| `OMB_HTTP_PORT` | `8080` | Server HTTP port (Docker) |
| `OMB_PUBLIC_URL` | `http://localhost:8080` | Public URL for webhooks |
| `OMB_UI_PORT` | `5199` | Vite dev server port |
| `OMB_PORT` | `8799` | Bot server API port |
| `ENGINES` | `@anthropic-ai/claude-code @openai/codex` | AI engines to install |

Each bot runs on an AI CLI you install (Claude Code, Codex, etc.) using your
own API key or login. NATION Team does not ship its own model.

## Deploy to Vercel

The web UI builds as a static Vite app. For a preview deployment:

```bash
vercel
```

The frontend needs a running bot server backend. For the full stack, use Docker:

```bash
docker compose up
```

## What's Working

- Three-column layout: bot roster, chat, shared computer
- Named persistent bots with colored identity marks
- DM and group (multi-bot) conversations
- Ask-first approval cards for consequential actions
- Computer panel with live screen preview and take-control
- Onboarding flow, welcome tour
- Multiple AI engine support (Claude, Codex, ACP, Grok, Ollama)
- Voice mode, browser automation, MCP tool integration
- Routines (scheduled bot actions)
- Team library for sharing bot packages
- i18n (English, German, Spanish, French, Hindi, Japanese, Portuguese, Ukrainian, Chinese)

## What's Stubbed / Next

- **Computer provider**: the shared computer backend is pluggable (local Docker/Podman, cloud VPS, or Apple containers). Wire to your preferred provider.
- **Auth**: the server trusts loopback by default. For multi-user, add auth via companion pairing, organization settings, or deploy behind an auth proxy.
- **thenation.city integration**: not yet wired into the NATION platform. This is the standalone chat-team product.
- **Production hosting**: Docker Compose or a Linux VPS is the intended self-hosting path. See `docs/self-hosting.md`.

## Upstream

This is a fork of [OpenMausBot](https://github.com/milind-soni/OpenMausBot)
(Apache-2.0). UX patterns are adapted from
[BOTROSTER](https://github.com/mandarwagh9/botroster).

See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for full attribution.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
