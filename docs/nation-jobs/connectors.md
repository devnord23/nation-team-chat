# Connector removal

No connector/integration/marketplace navigation, app connection cards or Slack
management links are available. The removed HTTP namespaces return 404 for all
callers before authorization. Configured credentials cannot enable managed
connectors, custom MCP servers or user-inherited connector settings. Built-in
agent coordination, browser and desktop MCP tools remain available.

No production settings or secrets were read or deleted. After reviewing other
services that may share them, the founder may remove these unused settings from
the API process: COMPOSIO_API_KEY, OMB_COMPOSIO_BROKER_URL,
OMB_COMPOSIO_BROKER_TOKEN, OMB_COMPOSIO_API, OMB_COMPOSIO_TOOLKITS_API,
OMB_CONNECTOR_UPSTREAM_URL, OMB_CONNECTOR_UPSTREAM_HEADERS,
OMB_CONNECTOR_TOKEN, OMB_CLAUDE_INHERIT_USER_CONFIG. Check process configuration for any additional
connector-prefixed overrides before deleting them; never remove model keys or
desk credentials as part of this cleanup.

No new environment variables. There is no enable switch. Existing configuration
and secrets are retained on disk for safe founder-controlled recovery.

Checks: connector 404 fixture, guided tour checks, and the NATION isolated server
fixture for bot creation, member privacy and team chat. No full-suite rerun or
live VPS changes. The inherited strict branding guard remains a release blocker.
