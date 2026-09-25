# Hosted NATION: what is private and what is shared

Applies when the workspace is multi-account (NATION API credits enforced or a
hosted sign-in). A single-user install keeps the upstream behaviour: one
identity, and every resource belongs to the owner.

Ownership always comes from the authenticated server session. A request
header, body field or query value never names the account. When no account
can be established, the resource is withheld (fail closed).

## Private to one account

| Resource | Key / rule |
| --- | --- |
| Bot conversations (tasks) | Owner recorded at creation. Each account has its own open task per bot. |
| Agent computer (Box, VPS) for a workspace bot | `botId--u-<sha256(env, account)>`. It is created on first use and reused on later turns and sessions. The operator keeps the bot's original computer. |
| Built-in browser session for a workspace bot | Same key as the computer. A member never gets the bot's saved browser profile. |
| Host desktop / Local VM | Operator only. A member's turn never reaches them. |
| Bot memory in a private conversation | `botId--m-<sha256(account)>` |
| Uploaded attachments | Served to the uploader, or to anyone who can see a conversation that carries the attachment. |
| Team Map delegation labels / edges | Shown only when the viewer can open the conversation(s) they came from. |
| Connected apps (Plugins) | Per-account backend identity (see `connectors.md`). |

## Shared on purpose

- **Team rooms** (non-DM groups): every member sees the transcript. A room
  turn runs and bills as the member who triggered it. It uses that member's
  own computer and browser for the bot, unless the room explicitly uses a
  **team computer**, which is shared by design and is only used in rooms.
- **Room memory**: `botId--team`, separate from every private namespace.
- **Bots themselves** (name, avatar, settings) are workspace-wide. Only the
  operator configures them.

## Legacy memory (before per-account scoping)

Before memory was scoped per account, every conversation of a bot, private
ones included, wrote to the bot's own namespace (`botId`). In a hosted
workspace that namespace is **quarantined**:

- no turn reads, searches or writes it, whether private, room, operator or
  member;
- it is kept untouched on disk;
- the operator can still review it in the bot's Memory settings. Members get
  403 there. Anything safe to keep can be copied into room memory by hand.

This is the fail-closed choice: legacy content can't be attributed to an
account after the fact, so it goes to no one. A single-user install still
uses `botId` exactly as before.

## Legacy attachments

A file uploaded before attachment ownership was recorded has no owner. It is
served to a member only when a conversation that member can see carries it.
Otherwise it reads as missing (404). The operator can still open it.

## Tests

- `server/nation-computer-isolation.e2e.test.ts`: two members share one bot.
  Covers: per-member computer and browser, persistence, isolation in both
  directions, forged headers, 403 on computer routes, one computer per member,
  per-member billing.
- `server/nation-attachments.e2e.test.ts`: cross-account direct-id 404, and
  refusal when an attachment is smuggled into a message.
- `server/nation-member-connectors.e2e.test.ts`: private memory, legacy memory
  quarantine, shared rooms.
- `server/team-map-view.test.ts`: Team Map visibility.
