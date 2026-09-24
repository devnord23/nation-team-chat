# Connected apps and agent computers

The workspace Plugins panel and trusted connection cards are restored. Composio
project credentials, Box tokens and the VPS SSH alias are managed at /admin,
under Apps & computers. Credentials remain write-only and owner-only.

The existing Composio key must be paired with an OAuth connection for each app.
An API key alone does not connect Gmail. Bot Access settings grant or revoke
connected-app access; the MCP bridge validates the bot and turn capability
before each relay. Workspace account management and arbitrary MCP configuration
remain owner-only. Other members do not receive the owner's account inventory.

NATION API keeps billing authority when the selected computer is Box or VPS.
VPS and browser stdio tools are mounted by the chat runtime. Box uses the existing
Box command and screenshot APIs with a required per-turn control lease. All tools
retain the normal approval flow. Screenshots are forwarded to the model in a
bounded image message after the tool replies.

Verification: connector authorization fixture, mock Gmail conversation including
approval and per-bot opt-out, Box command isolation/human control, desktop
screenshot transport, existing Composio tests, and the billing regression fixture.
