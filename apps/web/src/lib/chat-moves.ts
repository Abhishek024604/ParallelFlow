// Optimistic chat moves in the Private sidebar (drag and drop, or the row menu): a chat shows in its
// new place at once; the override is dropped once the server's list agrees, or on failure.

/** chat id → project id (null = Recent chats). */
export type ChatMoves = ReadonlyMap<string, string | null>;

interface MovableChat {
  id: string;
  private_project_id: string | null;
}

export function applyMoves<C extends MovableChat>(chats: readonly C[], moves: ChatMoves): C[] {
  if (moves.size === 0) return [...chats];
  return chats.map((chat) => {
    const to = moves.get(chat.id);
    return to === undefined || to === chat.private_project_id
      ? chat
      : { ...chat, private_project_id: to };
  });
}

/** The overrides the server has not caught up with yet. */
export function pendingMoves(moves: ChatMoves, serverChats: readonly MovableChat[]): ChatMoves {
  if (moves.size === 0) return moves;
  const byId = new Map(serverChats.map((c) => [c.id, c.private_project_id]));
  const next = new Map<string, string | null>();
  for (const [id, to] of moves) {
    if (byId.has(id) && byId.get(id) !== to) next.set(id, to);
  }
  return next.size === moves.size ? moves : next;
}

/** How a project's chat count changes with the overrides (server counts include unloaded chats). */
export function countDelta(
  projectId: string,
  serverChats: readonly MovableChat[],
  moves: ChatMoves,
): number {
  let delta = 0;
  for (const chat of serverChats) {
    const to = moves.get(chat.id);
    if (to === undefined || to === chat.private_project_id) continue;
    if (chat.private_project_id === projectId) delta -= 1;
    if (to === projectId) delta += 1;
  }
  return delta;
}
