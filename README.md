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

## OpenRouter (Recommended)

OpenRouter is the fastest path to a working bot — no direct Anthropic or OpenAI
key required.

**1. Get a free key at <https://openrouter.ai/keys>.**

**2. Set the environment variable:**

```bash
export OPENROUTER_API_KEY=sk-or-v1-…
# Optional: choose any model from https://openrouter.ai/models
export OPENROUTER_MODEL=meta-llama/llama-3.3-70b-instruct
```

Or copy `.env.example` to `.env` and fill in `OPENROUTER_API_KEY`.

**3. Start the server, create a bot, and select the engine:**

```
pnpm dev:server
pnpm dev        # → http://localhost:5199
```

In the UI: **New Bot → Engine → "OpenAI-compatible (OpenRouter / Groq)"**.  
The server reads `OPENROUTER_API_KEY` automatically — no extra config needed.

The `OPENROUTER_MODEL` variable sets the default model for the driver.
You can also override it per-bot in the bot settings panel.

### Model override

| Env var | Default | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | *(none)* | Your OpenRouter API key |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct` | Default model id |
| `OPENROUTER_API_URL` | `https://openrouter.ai/api/v1` | Override endpoint (Groq, llama.cpp, etc.) |

`OPENAI_COMPAT_API_KEY` / `OPENAI_COMPAT_MODEL` / `OPENAI_COMPAT_URL` are
legacy aliases for the same three variables.

## Environment Variables

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Description |
|---|---|---|
| `OMB_BIND_ADDRESS` | `127.0.0.1` | Server bind address |
| `OMB_HTTP_PORT` | `8080` | Server HTTP port (Docker) |
| `OMB_PUBLIC_URL` | `http://localhost:8080` | Public URL for webhooks |
| `OMB_UI_PORT` | `5199` | Vite dev server port |
| `OMB_PORT` | `8799` | Bot server API port |
| `ENGINES` | `@anthropic-ai/claude-code @openai/codex` | AI engines to install (optional when using OpenRouter) |
| `OPENROUTER_API_KEY` | *(none)* | OpenRouter API key |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct` | Default model for the OpenAI-compat driver |

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
- Multiple AI engine support (Claude, Codex, ACP, Grok, Ollama, **OpenRouter**)
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
