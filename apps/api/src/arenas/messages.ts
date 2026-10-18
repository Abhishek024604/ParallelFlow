import type {
  ArenaMessage,
  FileRef,
  ArenaMessagePage,
  ListArenaMessagesQuery,
  MessageArtifactRef,
  ProjectMember,
  SendArenaMessage,
  ThreadSummary,
} from '@saras/contracts';
import {
  acceptAnswer,
  answerBody,
  questionCard,
  splitAttachments,
  type StoredAnswer,
  type StoredQuestion,
  uuidv7,
} from '@saras/contracts';
import { notify, type Tx } from '@saras/db';
import { type RawBuilder, sql } from 'kysely';
import { resolveAttachments } from '../files/blobs.js';
import { bumpArenaUnread } from '../notifications/arena-unread.js';
import { mentionedUserIds } from '../notifications/mentions.js';
import { ApiError, notFound, validationFailed } from '../pipeline/errors.js';
import { decodeCursor, encodeCursor, type MessageCursor } from './cursor.js';
import { initials } from './naming.js';

// Arena chat (build step 3). Every function takes the pipeline's verified tenant transaction for the
// project (@ProjectScoped), so RLS (tenant + message_visibility) applies on top of these filters.
//
// Ordering is (created_at, id). Posts take a per-arena advisory lock and stamp created_at with
// clock_timestamp() after it, so created_at order is commit order: a poll that has seen a message has
// also seen every older one, and `after` never skips a message that committed late.
//
// Soft-deleted messages are left out (no tombstone): nothing deletes messages yet.
// Message bodies are never logged.

export const ARENA_POST = 'arena.post';

interface MessageRow {
  id: string;
  arena_id: string;
  parent_id: string | null;
  author_type: 'user' | 'agent' | 'system';
  author_id: string;
  display_name: string | null;
  roles: string[] | null;
  body: string;
  attachments: FileRef[] | null;
  artifact_refs: string[] | null;
  artifact_cards: MessageArtifactRef[] | null;
  edited_at: Date | null;
  created_at: string;
  /** A gate card: the message shares its id with the approval request (build step 7). */
  is_gate: boolean;
  thread: ThreadSummary | null;
}

const AI_NAME = 'AI';

function toMessage(row: MessageRow): ArenaMessage {
  const isAi = row.author_type !== 'user';
  const name = isAi ? AI_NAME : (row.display_name ?? 'Former teammate');
  return {
    id: row.id,
    arena_id: row.arena_id,
    parent_id: row.parent_id,
    author: {
      type: row.author_type,
      id: row.author_id,
      display_name: name,
      initials: isAi ? AI_NAME : initials(name),
      roles: isAi ? [] : (row.roles ?? []),
    },
    body: row.body,
    // Gate cards share their id with the approval request; Push cards carry artifact refs (people
    // cannot send those yet).
    kind: row.is_gate
      ? 'gate'
      : isAi
        ? 'agent'
        : (row.artifact_refs ?? []).length > 0
          ? 'event'
          : 'text',
    ...withQuestion(row.attachments),
    artifact_refs: row.artifact_refs ?? [],
    ...(row.artifact_cards?.length && { artifacts: row.artifact_cards }),
    ...(row.thread && { thread: { ...row.thread, reply_count: Number(row.thread.reply_count) } }),
    edited_at: row.edited_at ? row.edited_at.toISOString() : null,
    created_at: row.created_at,
  };
}

/** Files, plus the question card or answer marker stored next to them (questions.ts). */
export function withQuestion(stored: FileRef[] | null) {
  const { files, question, answer } = splitAttachments<FileRef>(stored);
  return {
    attachments: files,
    ...(question && { question: questionCard(question) }),
    ...(answer && { answer_to: { question_id: answer.question_id, choice: answer.choice } }),
  };
}

const cursorOf = (m: ArenaMessage): string =>
  encodeCursor({ createdAt: m.created_at, id: m.id } satisfies MessageCursor);

/** The arena of a project. Every project has exactly one. */
export async function arenaIdOf(tx: Tx, projectId: string): Promise<string> {
  const row = await tx
    .selectFrom('arenas')
    .select('id')
    .where('project_id', '=', projectId)
    .executeTakeFirst();
  if (!row) throw notFound();
  return row.id;
}

/** Whether `userId` has `capability` in the project (member_capabilities: roles, or Owner = all). */
export async function hasCapability(
  tx: Tx,
  projectId: string,
  userId: string,
  capability: string,
): Promise<boolean> {
  const row = await tx
    .selectFrom('member_capabilities')
    .select('capability')
    .where('project_id', '=', projectId)
    .where('user_id', '=', userId)
    .where('capability', '=', capability)
    .executeTakeFirst();
  return Boolean(row);
}

async function selectMessages(
  tx: Tx,
  projectId: string,
  /** The arena id, or an SQL expression that yields it. */
  arenaId: string | RawBuilder<unknown>,
  where: RawBuilder<unknown>,
  order: 'asc' | 'desc',
  limit: number,
): Promise<ArenaMessage[]> {
  const dir = sql.raw(order === 'asc' ? 'ASC' : 'DESC');
  const { rows } = await sql<MessageRow>`
    SELECT m.id, m.arena_id, m.parent_id, m.author_type, m.author_id, m.body, m.edited_at,
           m.attachments, m.artifact_refs,
           (SELECT json_agg(json_build_object('id', a.id, 'name', a.name,
                                              'head_version_no', a.head_version_no))
              FROM artifacts a WHERE a.id = ANY(m.artifact_refs)) AS artifact_cards,
           to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           u.display_name,
           EXISTS (SELECT 1 FROM approval_requests ar WHERE ar.id = m.id) AS is_gate,
           (SELECT array_agg(r.name ORDER BY r.system_kind = 'owner' DESC, r.name)
              FROM project_member_roles pmr
              JOIN project_roles r ON r.id = pmr.role_id
             WHERE pmr.project_id = ${projectId} AND pmr.user_id = m.author_id) AS roles,
           (SELECT json_build_object(
                     'reply_count', count(*),
                     'last_reply_at', to_char(max(r.created_at) AT TIME ZONE 'UTC',
                                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                     'last_reply_by', (SELECT CASE WHEN l.author_type = 'user'
                                                   THEN COALESCE(lu.display_name, 'Former teammate')
                                                   ELSE 'AI' END
                                         FROM messages l
                                         LEFT JOIN users lu ON l.author_type = 'user'
                                                           AND lu.id = l.author_id
                                        WHERE l.arena_id = m.arena_id AND l.parent_id = m.id
                                          AND l.deleted_at IS NULL
                                        ORDER BY l.created_at DESC, l.id DESC LIMIT 1))
              FROM messages r
             WHERE m.parent_id IS NULL AND r.arena_id = m.arena_id AND r.parent_id = m.id
               AND r.deleted_at IS NULL
            HAVING count(*) > 0) AS thread
      FROM messages m
      LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
     WHERE m.arena_id = ${arenaId} AND m.deleted_at IS NULL ${where}
     ORDER BY m.created_at ${dir}, m.id ${dir}
     LIMIT ${limit}`.execute(tx);
  return rows.map(toMessage);
}

function cursorParam(value: string, field: 'after' | 'cursor'): MessageCursor {
  const cursor = decodeCursor(value);
  if (!cursor) throw validationFailed([{ field, message: 'Invalid cursor' }]);
  return cursor;
}

/** GET /projects/{project_id}/arena/messages. */
export async function listArenaMessages(
  tx: Tx,
  projectId: string,
  query: ListArenaMessagesQuery,
): Promise<ArenaMessagePage> {
  // The project's arena as a subquery: one round trip per poll instead of two.
  const arenaId = sql`(SELECT a.id FROM arenas a WHERE a.project_id = ${projectId})`;
  const thread = query.parent_id ? sql`AND m.parent_id = ${query.parent_id}` : sql``;

  if (query.after) {
    // Polls without parent_id return replies too (the client updates its threads from them).
    // Polling: only newer messages, oldest first. More may follow; the next poll gets them.
    const after = cursorParam(query.after, 'after');
    const items = await selectMessages(
      tx,
      projectId,
      arenaId,
      sql`${thread} AND (m.created_at, m.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
      'asc',
      query.limit,
    );
    const last = items.at(-1);
    return { items, next_cursor: null, latest_cursor: last ? cursorOf(last) : query.after };
  }

  // The latest page, or the page before `cursor`: newest first in SQL, oldest first in the response.
  // The main stream's pages hold top-level messages only; replies live in their threads.
  const before = query.cursor ? cursorParam(query.cursor, 'cursor') : undefined;
  const scope = query.parent_id ? thread : sql`AND m.parent_id IS NULL`;
  const page = await selectMessages(
    tx,
    projectId,
    arenaId,
    before
      ? sql`${scope} AND (m.created_at, m.id) < (${before.createdAt}::timestamptz, ${before.id}::uuid)`
      : scope,
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
    // An older page says nothing about the newest message: keep polling from where you were.
    latest_cursor: !before && newest ? cursorOf(newest) : null,
  };
}

/**
 * One writer per arena at a time, until commit: created_at order = commit order (see top). Every
 * insert into an arena's stream (people and the AI) takes this lock first.
 */
export async function lockArenaMessages(tx: Tx, arenaId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`arena-messages:${arenaId}`}, 0))`.execute(
    tx,
  );
}

/** The AI's reply to a turn (system job tx for the arena's org). Returns the message id. */
export async function insertAgentMessage(
  tx: Tx,
  input: {
    orgId: string;
    arenaId: string;
    agentId: string;
    turnId: string;
    body: string;
    /** Documents the turn saved: shown as file cards under the reply. */
    artifactRefs?: string[];
    /** @AI asked inside a thread: the reply goes into that thread. */
    parentId?: string | null;
    /** The AI's question card (ask.question), stored as a typed element in attachments. */
    question?: StoredQuestion;
  },
): Promise<string> {
  await lockArenaMessages(tx, input.arenaId);
  const id = uuidv7();
  await sql`
    INSERT INTO messages (id, created_at, org_id, arena_id, parent_id, author_type, author_id, body,
                          turn_id, artifact_refs, attachments)
    VALUES (${id}, clock_timestamp(), ${input.orgId}, ${input.arenaId}, ${input.parentId ?? null},
            'agent', ${input.agentId}, ${input.body}, ${input.turnId},
            ${input.artifactRefs ?? []}::uuid[],
            ${JSON.stringify(input.question ? [input.question] : [])}::jsonb)`.execute(tx);
  if (input.parentId) return id;
  await bumpArenaUnread(tx, {
    arenaId: input.arenaId,
    messageId: id,
    author: { type: 'agent', id: input.agentId, name: AI_NAME },
    body: input.body,
  });
  return id;
}

/**
 * A stream card from a person's action (Push to Arena): their message with the artifact in
 * `artifact_refs`. Verified tenant tx; needs arena.post like any post (RLS backstop). Takes the lock.
 */
export async function insertArenaCard(
  tx: Tx,
  input: { orgId: string; arenaId: string; userId: string; body: string; artifactRefs: string[] },
): Promise<string> {
  await lockArenaMessages(tx, input.arenaId);
  const id = uuidv7();
  await sql`
    INSERT INTO messages (id, created_at, org_id, arena_id, author_type, author_id, body, artifact_refs)
    VALUES (${id}, clock_timestamp(), ${input.orgId}, ${input.arenaId}, 'user', ${input.userId},
            ${input.body}, ${input.artifactRefs}::uuid[])`.execute(tx);
  await bumpArenaUnread(tx, {
    arenaId: input.arenaId,
    messageId: id,
    author: { type: 'user', id: input.userId, name: await displayName(tx, input.userId) },
    body: input.body,
  });
  return id;
}

async function displayName(tx: Tx, userId: string): Promise<string> {
  const row = await tx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.display_name ?? 'A teammate';
}

/**
 * Teammates named as "@Name" (or a unique "@firstname") in a message: a row in message_mentions and
 * a high-priority Inbox item that links to the message (same transaction as the post). The author
 * is never notified of their own message. Returns who was tagged.
 */
async function notifyMentions(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  message: { id: string; createdAt: string; body: string; deepLink: string },
  authorName: string,
): Promise<string[]> {
  if (!message.body.includes('@')) return [];
  const members = await tx
    .selectFrom('project_members as pm')
    .innerJoin('users as u', 'u.id', 'pm.user_id')
    .select(['pm.user_id', 'u.display_name'])
    .where('pm.project_id', '=', ctx.projectId)
    .execute();
  const tagged = mentionedUserIds(message.body, members).filter((id) => id !== ctx.userId);
  if (tagged.length === 0) return [];
  await sql`
    INSERT INTO message_mentions (org_id, message_id, message_created_at, mentioned_type,
                                  mentioned_id)
    SELECT ${ctx.orgId}, ${message.id}, ${message.createdAt}::timestamptz, 'user', id
      FROM unnest(${tagged}::uuid[]) AS id
    ON CONFLICT DO NOTHING`.execute(tx);
  await notify(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'tag',
    title: `${authorName} mentioned you`,
    preview: message.body,
    resourceType: 'message',
    resourceId: message.id,
    deepLink: message.deepLink,
    actor: { type: 'user', id: ctx.userId },
    requiresAction: true,
    dedupeKey: `mention:${message.id}`,
    recipients: { userIds: tagged },
  });
  return tagged;
}

/** GET /projects/{project_id}/arena/messages/{message_id}: one message (a thread's root). */
export async function getArenaMessage(
  tx: Tx,
  projectId: string,
  messageId: string,
): Promise<ArenaMessage> {
  const arenaId = sql`(SELECT a.id FROM arenas a WHERE a.project_id = ${projectId})`;
  const [message] = await selectMessages(
    tx,
    projectId,
    arenaId,
    sql`AND m.id = ${messageId}`,
    'asc',
    1,
  );
  if (!message) throw notFound();
  return message;
}

/** POST /projects/{project_id}/arena/messages. The caller is a verified active member. */
export async function postArenaMessage(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  input: SendArenaMessage,
  /** An answer to an AI question: stored as a marker next to the files (answerArenaQuestion). */
  answer?: StoredAnswer,
): Promise<ArenaMessage> {
  // Checked here first so the answer is a clear 403; RLS (arena_post_requires_capability) is the
  // backstop and would surface as a 404.
  if (!(await hasCapability(tx, ctx.projectId, ctx.userId, ARENA_POST))) {
    throw new ApiError(403, 'FORBIDDEN', {
      detail: 'You can read this arena but not post.',
      requiredPermission: `cap ${ARENA_POST}`,
    });
  }
  const arenaId = await arenaIdOf(tx, ctx.projectId);

  // A reply goes into the thread of a top-level message: a reply to a reply joins the same thread.
  let root: { id: string; author_type: string; author_id: string } | undefined;
  if (input.parent_id) {
    const parent = await tx
      .selectFrom('messages')
      .select(['id', 'parent_id', 'author_type', 'author_id'])
      .where('id', '=', input.parent_id)
      .where('arena_id', '=', arenaId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!parent) {
      throw validationFailed(
        [{ field: 'parent_id', message: 'No such message in this arena' }],
        'The message you replied to is not in this arena.',
      );
    }
    root = parent.parent_id
      ? await tx
          .selectFrom('messages')
          .select(['id', 'author_type', 'author_id'])
          .where('id', '=', parent.parent_id)
          .where('arena_id', '=', arenaId)
          .executeTakeFirst()
      : parent;
    if (!root) {
      throw validationFailed(
        [{ field: 'parent_id', message: 'No such message in this arena' }],
        'The message you replied to is not in this arena.',
      );
    }
  }
  const parentId = root?.id ?? null;

  // Files uploaded to this arena only (its org's blobs).
  const attachments = await resolveAttachments(tx, { org: ctx.orgId }, input.attachments);

  await lockArenaMessages(tx, arenaId);
  const id = uuidv7();
  const {
    rows: [inserted],
  } = await sql<{ created_at: string }>`
    INSERT INTO messages (id, created_at, org_id, arena_id, parent_id, author_type, author_id, body,
                          attachments)
    VALUES (${id}, clock_timestamp(), ${ctx.orgId}, ${arenaId}, ${parentId},
            'user', ${ctx.userId}, ${input.body},
            ${JSON.stringify(answer ? [...attachments, answer] : attachments)}::jsonb)
    RETURNING created_at::text`.execute(tx);

  const authorName = await displayName(tx, ctx.userId);
  const deepLink = parentId
    ? `/arena/${ctx.projectId}?message=${parentId}&reply=${id}`
    : `/arena/${ctx.projectId}?message=${id}`;
  const tagged = await notifyMentions(
    tx,
    ctx,
    { id, createdAt: inserted?.created_at ?? new Date().toISOString(), body: input.body, deepLink },
    authorName,
  );
  // A reply tells the thread's author (unless they wrote it, or were just tagged in it).
  if (root && root.author_type === 'user' && !tagged.includes(root.author_id)) {
    await notify(tx, {
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      type: 'tag',
      title: `${authorName} replied to your message`,
      preview: input.body,
      resourceType: 'message',
      resourceId: id,
      deepLink,
      actor: { type: 'user', id: ctx.userId },
      requiresAction: true,
      dedupeKey: `reply:${id}`,
      recipients: { userIds: [root.author_id] },
    });
  }
  if (!parentId) {
    await bumpArenaUnread(tx, {
      arenaId,
      messageId: id,
      author: { type: 'user', id: ctx.userId, name: authorName },
      body: input.body,
    });
  }

  const [message] = await selectMessages(
    tx,
    ctx.projectId,
    arenaId,
    sql`AND m.id = ${id}`,
    'asc',
    1,
  );
  if (!message) throw new Error('Posted message is not readable');
  return message;
}

/**
 * POST /projects/{project_id}/arena/messages/{message_id}/answer: the person the AI asked picks an
 * answer. Their answer is posted as their message ("<question> → <choice>", in the same thread) and
 * the question card is marked answered, under the arena lock so a second answer gets a 409. The
 * caller starts the AI's next turn with it. Returns the answer message and the question.
 */
export async function answerArenaQuestion(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  questionId: string,
  rawChoice: string,
): Promise<{ message: ArenaMessage; question: StoredQuestion }> {
  const arenaId = await arenaIdOf(tx, ctx.projectId);
  await lockArenaMessages(tx, arenaId);
  const row = await tx
    .selectFrom('messages')
    .select(['id', 'parent_id', 'author_type', 'attachments'])
    .where('id', '=', questionId)
    .where('arena_id', '=', arenaId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  const stored = row ? splitAttachments<FileRef>(row.attachments as unknown[]) : null;
  const question = row?.author_type !== 'user' ? stored?.question : null;
  if (!row || !stored || !question) throw notFound();
  if (question.asked_of !== ctx.userId) {
    throw new ApiError(403, 'FORBIDDEN', {
      detail: `Only ${question.asked_of_name} can answer this question.`,
    });
  }
  if (question.answer) {
    throw new ApiError(409, 'CONFLICT', { detail: 'This question has already been answered.' });
  }
  const choice = acceptAnswer(question, rawChoice);
  if (!choice) {
    throw validationFailed([
      {
        field: 'choice',
        message: question.allow_other ? 'Write a shorter answer' : 'Pick one of the options',
      },
    ]);
  }
  const message = await postArenaMessage(
    tx,
    ctx,
    {
      body: answerBody(question.question, choice),
      ...(row.parent_id && { parent_id: row.parent_id }),
    },
    { type: 'answer', question_id: questionId, choice },
  );
  const answered: StoredQuestion = {
    ...question,
    answer: { choice, message_id: message.id, at: message.created_at },
  };
  await sql`
    UPDATE messages SET attachments = ${JSON.stringify([...stored.files, answered])}::jsonb
     WHERE id = ${questionId} AND arena_id = ${arenaId}`.execute(tx);
  return { message, question: answered };
}

interface MemberRow {
  user_id: string;
  display_name: string;
  email: string;
  added_at: Date;
  roles: { id: string; name: string }[];
  is_owner: boolean;
}

/** GET /projects/{project_id}/members: active members, the owner first, then by join date. */
export async function listProjectMembers(tx: Tx, projectId: string): Promise<ProjectMember[]> {
  const { rows } = await sql<MemberRow>`
    SELECT pm.user_id, u.display_name, u.email, pm.added_at,
           COALESCE(json_agg(json_build_object('id', r.id, 'name', r.name)
                             ORDER BY r.system_kind = 'owner' DESC, r.name)
                    FILTER (WHERE r.id IS NOT NULL), '[]'::json) AS roles,
           COALESCE(bool_or(r.system_kind = 'owner'), false) AS is_owner
      FROM project_members pm
      JOIN org_memberships om ON om.org_id = pm.org_id AND om.user_id = pm.user_id
                             AND om.status = 'active'
      JOIN users u ON u.id = pm.user_id AND u.deactivated_at IS NULL
      LEFT JOIN project_member_roles pmr ON pmr.project_id = pm.project_id AND pmr.user_id = pm.user_id
      LEFT JOIN project_roles r ON r.id = pmr.role_id
     WHERE pm.project_id = ${projectId}
     GROUP BY pm.user_id, u.display_name, u.email, pm.added_at
     ORDER BY is_owner DESC, pm.added_at, pm.user_id`.execute(tx);
  return rows.map((row) => ({
    user_id: row.user_id,
    display_name: row.display_name,
    initials: initials(row.display_name),
    email: row.email,
    roles: row.roles,
    is_owner: row.is_owner,
    added_at: row.added_at.toISOString(),
  }));
}
