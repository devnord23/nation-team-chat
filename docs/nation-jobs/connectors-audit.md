# Managed connectors: member-surface audit

Scope: everything a normal (non-admin) member can see in a hosted NATION
workspace. Upstream brand names and provider configuration must not appear;
internal adapters and wire field names stay (renaming them would break
connector compatibility).

| Surface | Finding | Status |
| --- | --- | --- |
| Plugins panel (catalog, inventory, connect/disconnect, OAuth states) | No vendor name, key field or dashboard link is rendered. Backend errors reach members only as NATION wording (`public-response.ts` audience redaction). | OK. The `nation-member-connectors` e2e scans every member response for the vendor name and key shapes. |
| Agent Access settings (Connected apps switch) | Owner-only. The UI text says "Connected apps". | OK |
| `/admin` → Apps & computers | Names the connected-apps backend, key fields and dashboards. | Admin only (members get 403 on its APIs and see "Admin access required"). |
| `/admin` → Agent controls | Configured state and provider kinds only. No credential values. | Admin only |
| `request_credential` agent tool in a member's conversation | Could post a "provide your API key" card for an upstream provider (xAI, Box, voice...) into a member's chat. | **Fixed.** Hosted member turns get a NATION "not set up in this workspace" result with no card. Test: `nation-admin-controls.e2e`. |
| Tool receipts / transcript for connected-app calls | Tool names are `apps_*`. No vendor name appears. | OK |
| `/api/config` for members | `composio`/`box` are `{configured}` booleans only. No `webTools`, prices, provider or routing detail. | OK |
| Web search failures | NATION wording. The provider name, key and error text never reach the model or the member. | OK (`nation-web-tools.e2e`) |
| Model slugs | Routed model ids never reach member responses. | OK (`nation-member-connectors.e2e`) |
| `ApiKeys.tsx` rows (`keys.composio.*`, OpenRouter link) and `OrganizationSettings.tsx` | Contain vendor names and dashboard links but are **not rendered anywhere in the app** (only imported by their own tests). | Not reachable. Left in place because removing them is out of scope. |
| Code comments and wire field names (`composio`, `composioMcp`, `ToolkitCard`) | Internal identifiers | Kept on purpose, for connector and API compatibility |

Not verified here: live OAuth against real Gmail, GitHub or Notion. No real
provider credentials are configured in this environment. All connector
evidence comes from owned loopback fixtures.
