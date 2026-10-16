import type {
  ChatMessagePage,
  CreatePrivateChat,
  FileRef,
  ListArenaMessagesQuery,
  ListPrivateChatsQuery,
  PrivateChat,
  PrivateMessage,
  PrivateProject,
} from '@saras/contracts';
import { titleFromMessage, uuidv7 } from '@saras/contracts';
import type { Tx } from '@saras/db';
import { type RawBuilder, sql } from 'kysely';
import { decodeCursor, encodeCursor, type MessageCursor } from '../arenas/cursor.js';
import { initials } from '../arenas/naming.js';
import { resolveAttachments } from '../files/blobs.js';
import { notFound, validationFailed } from '../pipeline/errors.js';

// Private chats and projects (build step 5, ADR-034). Every function takes the pipeline's user-scope
// transaction (db.withUser): RLS (private_space_* policies) shows only the caller's own Private rows,
// and each query also filters by owner. Anything else is 404. Message bodies are never logged.
//
// Messages use the arena's ordering rules: (created_at, id), a per-chat advisory lock and
// clock_timestamp(), so `after` polling never skips a late commit.

interface ChatRow {
  id: string;
  title: string | null;
  private_project_id: string | null;
  bound_project_id: string | null;
  last_message_at: Date | null;
  created_at: Date;
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

type Linked = Map<string, { id: string; key: string; name: string }>;

/**
 * Names of the arenas these chats are linked to. User scope shows the projects you are a member of;
 * a chat linked to an arena you have left stays linked (write-once) and shows a plain "Arena".
 */
async function linkedArenas(tx: Tx, rows: readonly ChatRow[]): Promise<Linked> {
  const ids = [...new Set(rows.flatMap((r) => (r.bound_project_id ? [r.bound_project_id] : [])))];
  if (ids.length === 0) return new Map();
  const projects = await tx
    .selectFrom('projects')
    .select(['id', 'key', 'name'])
    .where('id', 'in', ids)
    .execute();
  return new Map(projects.map((p) => [p.id, p]));
}

function toChat(row: ChatRow, linked: Linked): PrivateChat {
  const bound = row.bound_project_id;
  return {
    id: row.id,
    title: row.title,
    private_project_id: row.private_project_id,
    bound_project: bound ? (linked.get(bound) ?? { id: bound, key: '', name: 'Arena' }) : null,
    model_class: 'balanced',
    last_message_at: iso(row.last_message_at),
    created_at: iso(row.created_at) ?? '',
  };
}

const CHAT_COLUMNS = [
  'id',
  'title',
  'private_project_id',
  'bound_project_id',
  'last_message_at',
  'created_at',
] as const;

/** `%`, `_` and `\` are literal in a title search. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** GET /private/sessions: most recent activity first. */
export async function listChats(
  tx: Tx,
  userId: string,
  query: ListPrivateChatsQuery,
): Promise<PrivateChat[]> {
  let select = tx
    .selectFrom('private_sessions')
    .select(CHAT_COLUMNS)
    .where('owner_user_id', '=', userId)
    .where('is_archived', '=', false);
  if (query.q) select = select.where('title', 'ilike', likePattern(query.q));
  const rows = await select
    .orderBy(sql`coalesce(last_message_at, created_at)`, 'desc')
    .orderBy('id', 'desc')
    .limit(query.limit)
    .execute();
  const linked = await linkedArenas(tx, rows);
  return rows.map((row) => toChat(row, linked));
}

/** One of your chats, or 404. */
export async function getChat(tx: Tx, userId: string, id: string): Promise<PrivateChat> {
  const row = await tx
    .selectFrom('private_sessions')
    .select(CHAT_COLUMNS)
    .where('id', '=', id)
    .where('owner_user_id', '=', userId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return toChat(row, await linkedArenas(tx, [row]));
}

async function requireProject(tx: Tx, userId: string, projectId: string): Promise<void> {
  const row = await tx
    .selectFrom('private_projects')
    .select('id')
    .where('id', '=', projectId)
    .where('user_id', '=', userId)
    .where('archived_at', 'is', null)
    .executeTakeFirst();
  if (!row) {
    throw validationFailed([{ field: 'private_project_id', message: 'No such project' }]);
  }
}

/** POST /private/sessions. */
export async function createChat(
  tx: Tx,
  userId: string,
  input: CreatePrivateChat,
): Promise<PrivateChat> {
  if (input.private_project_id) await requireProject(tx, userId, input.private_project_id);
  const row = await tx
    .insertInto('private_sessions')
    .values({
      id: uuidv7(),
      org_id: null,
      owner_user_id: userId,
      title: input.title ?? null,
      private_project_id: input.private_project_id ?? null,
    })
    .returning(CHAT_COLUMNS)
    .executeTakeFirstOrThrow();
  return toChat(row, await linkedArenas(tx, [row]));
}

/** PATCH /private/sessions/{id}. */
export async function renameChat(
  tx: Tx,
  userId: string,
  id: string,
  title: string,
): Promise<PrivateChat> {
  const row = await tx
    .updateTable('private_sessions')
    .set({ title })
    .where('id', '=', id)
    .where('owner_user_id', '=', userId)
    .returning(CHAT_COLUMNS)
    .executeTakeFirst();
  if (!row) throw notFound();
  return toChat(row, await linkedArenas(tx, [row]));
}

/** PUT /private/sessions/{id}/project: file in a project, or back to Recent (null). */
export async function moveChat(
  tx: Tx,
  userId: string,
  id: string,
  projectId: string | null,
): Promise<PrivateChat> {
  await getChat(tx, userId, id);
  if (projectId) await requireProject(tx, userId, projectId);
  const row = await tx
    .updateTable('private_sessions')
    .set({ private_project_id: projectId })
    .where('id', '=', id)
    .where('owner_user_id', '=', userId)
    .returning(CHAT_COLUMNS)
    .executeTakeFirstOrThrow();
  return toChat(row, await linkedArenas(tx, [row]));
}

/**
 * DELETE /private/sessions/{id}: the chat, its messages, AI turns and agent session. The runtime
 * session is not archived yet (SLICE_DEBT).
 */
export async function deleteChat(tx: Tx, userId: string, id: string): Promise<void> {
  await getChat(tx, userId, id);
  await sql`DELETE FROM app_tool_calls WHERE turn_id IN (
              SELECT t.id FROM runtime_turns t JOIN agent_sessions s ON s.id = t.agent_session_id
               WHERE s.private_session_id = ${id})`.execute(tx);
  await sql`DELETE FROM runtime_turns WHERE agent_session_id IN (
              SELECT id FROM agent_sessions WHERE private_session_id = ${id})`.execute(tx);
  await sql`DELETE FROM messages WHERE private_session_id = ${id}`.execute(tx);
  await tx.deleteFrom('agent_sessions').where('private_session_id', '=', id).execute();
  await tx
    .deleteFrom('private_sessions')
    .where('id', '=', id)
    .where('owner_user_id', '=', userId)
    .execute();
}

// ---------------------------------------------------------------- messages

interface MessageRow {
  id: string;
  private_session_id: string;
  parent_id: string | null;
  author_type: 'user' | 'agent' | 'system';
  author_id: string;
  display_name: string | null;
  body: string;
  attachments: FileRef[] | null;
  artifact_refs: string[] | null;
  edited_at: Date | null;
  created_at: string;
}

const AI_NAME = 'AI';

function toMessage(row: MessageRow): PrivateMessage {
  const isAi = row.author_type !== 'user';
  const name = isAi ? AI_NAME : (row.display_name ?? 'You');
  return {
    id: row.id,
    private_session_id: row.private_session_id,
    parent_id: row.parent_id,
    author: {
      type: row.author_type,
      id: row.author_id,
      display_name: name,
      initials: isAi ? AI_NAME : initials(name),
      roles: [],
    },
    body: row.body,
    kind: isAi ? 'agent' : 'text',
    attachments: row.attachments ?? [],
    artifact_refs: row.artifact_refs ?? [],
    edited_at: row.edited_at ? row.edited_at.toISOString() : null,
    created_at: row.created_at,
  };
}

const cursorOf = (m: PrivateMessage): string =>
  encodeCursor({ createdAt: m.created_at, id: m.id } satisfies MessageCursor);

async function selectMessages(
  tx: Tx,
  sessionId: string,
  where: RawBuilder<unknown>,
  order: 'asc' | 'desc',
  limit: number,
): Promise<PrivateMessage[]> {
  const dir = sql.raw(order === 'asc' ? 'ASC' : 'DESC');
  const { rows } = await sql<MessageRow>`
    SELECT m.id, m.private_session_id, m.parent_id, m.author_type, m.author_id, m.body, m.edited_at,
           m.attachments, m.artifact_refs,
           to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           u.display_name
      FROM messages m
      LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
     WHERE m.private_session_id = ${sessionId} AND m.org_id IS NULL AND m.deleted_at IS NULL ${where}
     ORDER BY m.created_at ${dir}, m.id ${dir}
     LIMIT ${limit}`.execute(tx);
  return rows.map(toMessage);
}

function cursorParam(value: string, field: 'after' | 'cursor'): MessageCursor {
  const cursor = decodeCursor(value);
  if (!cursor) throw validationFailed([{ field, message: 'Invalid cursor' }]);
  return cursor;
}

/** GET /private/sessions/{id}/messages: same paging and `after` polling as the arena. */
export async function listPrivateMessages(
  tx: Tx,
  userId: string,
  sessionId: string,
  query: Omit<ListArenaMessagesQuery, 'parent_id'>,
): Promise<ChatMessagePage<PrivateMessage>> {
  // Ownership only (one round trip per poll): the chat's details are not part of the page.
  const own = await tx
    .selectFrom('private_sessions')
    .select('id')
    .where('id', '=', sessionId)
    .where('owner_user_id', '=', userId)
    .executeTakeFirst();
  if (!own) throw notFound();
  if (query.after) {
    const after = cursorParam(query.after, 'after');
    const items = await selectMessages(
      tx,
      sessionId,
      sql`AND (m.created_at, m.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
      'asc',
      query.limit,
    );
    const last = items.at(-1);
    return { items, next_cursor: null, latest_cursor: last ? cursorOf(last) : query.after };
  }
  const before = query.cursor ? cursorParam(query.cursor, 'cursor') : undefined;
  const page = await selectMessages(
    tx,
    sessionId,
    before
      ? sql`AND (m.created_at, m.id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`
      : sql``,
    'desc',
    query.limit + 1,
  );
  const hasOlder = page.length > query.limit;
  const items = page.slice(0, query.limit).reverse();
  const oldest = items[0];
  const newest = items.at(-1);
  return {
    items,
    next_cursor: hasOlder && oldest ? cursorOf(oldest) : null,
    latest_cursor: !before && newest ? cursorOf(newest) : null,
  };
}

/** One writer per chat at a time, until commit (created_at order = commit order). */
async function lockChatMessages(tx: Tx, sessionId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`private-messages:${sessionId}`}, 0))`.execute(
    tx,
  );
}

async function insertMessage(
  tx: Tx,
  sessionId: string,
  author: { type: 'user' | 'agent'; id: string },
  body: string,
  turnId: string | null,
  attachments: FileRef[] = [],
): Promise<string> {
  await lockChatMessages(tx, sessionId);
  const id = uuidv7();
  await sql`
    INSERT INTO messages (id, created_at, org_id, private_session_id, author_type, author_id, body, turn_id,
                          attachments)
    VALUES (${id}, clock_timestamp(), NULL, ${sessionId}, ${author.type}, ${author.id}, ${body}, ${turnId},
            ${JSON.stringify(attachments)}::jsonb)`.execute(tx);
  // The first message names an unnamed chat.
  await sql`UPDATE private_sessions
               SET last_message_at = now(), title = coalesce(title, ${titleFromMessage(body)})
             WHERE id = ${sessionId}`.execute(tx);
  return id;
}

/** POST /private/sessions/{id}/messages: your message. */
export async function postPrivateMessage(
  tx: Tx,
  userId: string,
  sessionId: string,
  body: string,
  attachmentIds?: readonly string[],
): Promise<PrivateMessage> {
  await getChat(tx, userId, sessionId);
  // Files uploaded to your own Private space only.
  const attachments = await resolveAttachments(tx, { user: userId }, attachmentIds);
  const id = await insertMessage(
    tx,
    sessionId,
    { type: 'user', id: userId },
    body,
    null,
    attachments,
  );
  const [message] = await selectMessages(tx, sessionId, sql`AND m.id = ${id}`, 'asc', 1);
  if (!message) throw new Error('Posted message is not readable');
  return message;
}

/** The personal agent's reply to a turn (user scope, as the owner). Returns the message id. */
export function insertPrivateAgentMessage(
  tx: Tx,
  input: { sessionId: string; agentId: string; turnId: string; body: string },
): Promise<string> {
  return insertMessage(
    tx,
    input.sessionId,
    { type: 'agent', id: input.agentId },
    input.body,
    input.turnId,
  );
}

/** A note from your AI in the chat that no turn produced (e.g. "Linked to arena · X"). */
export async function insertPrivateNote(
  tx: Tx,
  input: { sessionId: string; agentId: string; body: string },
): Promise<PrivateMessage> {
  const id = await insertMessage(
    tx,
    input.sessionId,
    { type: 'agent', id: input.agentId },
    input.body,
    null,
  );
  const [message] = await selectMessages(tx, input.sessionId, sql`AND m.id = ${id}`, 'asc', 1);
  if (!message) throw new Error('Note is not readable');
  return message;
}

// ---------------------------------------------------------------- projects

interface ProjectRow {
  id: string;
  name: string;
  created_at: Date;
  chat_count: number;
}

const toProject = (row: ProjectRow): PrivateProject => ({
  id: row.id,
  name: row.name,
  chat_count: Number(row.chat_count),
  created_at: iso(row.created_at) ?? '',
});

/** GET /private/projects: oldest first, with chat counts. */
export async function listProjects(tx: Tx, userId: string): Promise<PrivateProject[]> {
  const { rows } = await sql<ProjectRow>`
    SELECT p.id, p.name, p.created_at,
           (SELECT count(*)::int FROM private_sessions s
             WHERE s.private_project_id = p.id AND NOT s.is_archived) AS chat_count
      FROM private_projects p
     WHERE p.user_id = ${userId} AND p.archived_at IS NULL
     ORDER BY p.created_at, p.id`.execute(tx);
  return rows.map(toProject);
}

/** POST /private/projects. */
export async function createProject(tx: Tx, userId: string, name: string): Promise<PrivateProject> {
  const row = await tx
    .insertInto('private_projects')
    .values({ id: uuidv7(), user_id: userId, name })
    .returning(['id', 'name', 'created_at'])
    .executeTakeFirstOrThrow();
  return toProject({ ...row, chat_count: 0 });
}

/** PATCH /private/projects/{id}. */
export async function renameProject(
  tx: Tx,
  userId: string,
  id: string,
  name: string,
): Promise<PrivateProject> {
  const row = await tx
    .updateTable('private_projects')
    .set({ name })
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('archived_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!row) throw notFound();
  const project = (await listProjects(tx, userId)).find((p) => p.id === id);
  if (!project) throw notFound();
  return project;
}

/** DELETE /private/projects/{id}: its chats move to Recent (FK ON DELETE SET NULL), never deleted. */
export async function deleteProject(tx: Tx, userId: string, id: string): Promise<void> {
  const row = await tx
    .deleteFrom('private_projects')
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .returning('id')
    .executeTakeFirst();
  if (!row) throw notFound();
}
