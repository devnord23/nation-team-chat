/** Product policy is unconditional: persisted credentials cannot re-enable it. */
export const CONNECTORS_ENABLED: boolean = false;

export function removedConnectorPath(path: string): boolean {
  return /^\/(?:swarm\/)?(?:connectors|integrations|marketplace|plugins)(?:\/|$)/i.test(path)
    || /^\/api\/(?:internal\/)?(?:connectors|integrations|marketplace|plugins|composio|mcp)(?:\/|$)/i.test(path)
    || /^\/api\/bots\/[^/]+\/slack-management(?:\/|$)/i.test(path);
}
