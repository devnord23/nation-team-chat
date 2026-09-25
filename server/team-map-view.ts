// The live Team Map as one viewer may see it. The map carries only ids,
// relationships, optional delegation labels and timestamps, but a label is
// written from a conversation ("Delegated to @B: <reason>"), and even an edge
// says that conversation is active. So in a hosted workspace every entry
// follows the visibility of the conversation(s) it came from: an entry from a
// conversation the viewer cannot open is left out whole, never half-redacted.

export interface TeamMapSources {
  visibleBotIds: ReadonlySet<string>;
  /** bot-to-bot direct rooms (`dm`) with their thread */
  directRooms: Array<{ groupId: string; threadId: string; botIds: [string, string]; lastAt: number }>;
  queued: Array<{ sourceThreadId: string; sourceBotId: string; toBotId: string; reason?: string; targetThreadId?: string }>;
  running: Array<{ threadId: string; toBotId: string; sourceBotId?: string; sourceThreadId?: string; groupId?: string }>;
}

export interface TeamMapView {
  collaborations: Array<{ groupId: string; botIds: [string, string]; lastAt: number }>;
  queued: Array<{ sourceBotId: string; targetBotId: string; reason?: string }>;
  running: Array<{ sourceBotId: string; targetBotId: string; threadId: string; groupId?: string }>;
}

/** `canSee(threadId)` is the viewer's conversation visibility (always true on
 * a single-user install and for the operator). */
export function teamMapFor(sources: TeamMapSources, canSee: (threadId: string) => boolean): TeamMapView {
  const visible = sources.visibleBotIds;
  const collaborations = sources.directRooms
    .filter((room) => room.botIds.every((botId) => visible.has(botId)) && canSee(room.threadId))
    .map(({ groupId, botIds, lastAt }) => ({ groupId, botIds, lastAt }))
    .sort((a, b) => b.lastAt - a.lastAt);
  const queued = sources.queued.flatMap((item) => {
    if (!visible.has(item.sourceBotId) || !visible.has(item.toBotId)) return [];
    if (!canSee(item.sourceThreadId) || (item.targetThreadId && !canSee(item.targetThreadId))) return [];
    return [{ sourceBotId: item.sourceBotId, targetBotId: item.toBotId, ...(item.reason ? { reason: item.reason } : {}) }];
  });
  const running = sources.running.flatMap((item) => {
    if (!item.sourceBotId || !visible.has(item.sourceBotId) || !visible.has(item.toBotId)) return [];
    if (!canSee(item.threadId) || (item.sourceThreadId && !canSee(item.sourceThreadId))) return [];
    return [{ sourceBotId: item.sourceBotId, targetBotId: item.toBotId, threadId: item.threadId, ...(item.groupId ? { groupId: item.groupId } : {}) }];
  });
  return { collaborations, queued, running };
}
