import { z } from 'zod';
import { type FileRef, MESSAGE_ATTACHMENTS_MAX } from './files.js';

// Arena chat and members (openapi_v2.yaml: listArenaMessages, postArenaMessage, listProjectMembers).
// Message bodies are plain text in this step: no markdown, no mention parsing.

/** Characters (OpenAPI SendMessage.body maxLength). */
export const MESSAGE_BODY_MAX_CHARS = 20_000;
/** UTF-8 bytes: the 20 KB message limit of doc 10 §10.5. */
export const MESSAGE_BODY_MAX_BYTES = 20 * 1024;
export const MESSAGE_PAGE_MAX = 100;
export const MESSAGE_PAGE_DEFAULT = 50;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const Uuid = z
  .string()
  .uuid('Must be a uuid')
  .transform((id) => id.toLowerCase());

/**
 * POST /projects/{project_id}/arena/messages and POST /private/sessions/{id}/messages body.
 * `attachments`: file ids from an upload to the same arena or your Private space. Artifact refs come later.
 */
export const SendArenaMessageSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, 'Write a message first')
      .max(MESSAGE_BODY_MAX_CHARS, `At most ${MESSAGE_BODY_MAX_CHARS} characters`)
      .refine((text) => utf8Bytes(text) <= MESSAGE_BODY_MAX_BYTES, 'At most 20 KB'),
    parent_id: Uuid.optional(),
    attachments: z
      .array(Uuid)
      .max(MESSAGE_ATTACHMENTS_MAX, `At most ${MESSAGE_ATTACHMENTS_MAX} files`)
      .optional(),
  })
  .strict();
export type SendArenaMessageInput = z.input<typeof SendArenaMessageSchema>;
export type SendArenaMessage = z.output<typeof SendArenaMessageSchema>;

/**
 * GET /projects/{project_id}/arena/messages query. No cursor: the latest page. `after`: only newer
 * messages, oldest first (polling). `cursor`: the page before it (older messages).
 */
export const ListArenaMessagesQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int('Must be a whole number')
      .min(1, 'At least 1')
      .max(MESSAGE_PAGE_MAX, `At most ${MESSAGE_PAGE_MAX}`)
      .default(MESSAGE_PAGE_DEFAULT),
    after: z.string().max(200).optional(),
    cursor: z.string().max(200).optional(),
    parent_id: Uuid.optional(),
  })
  .refine((q) => !(q.after && q.cursor), {
    message: 'Pass either after or cursor, not both',
    path: ['after'],
  });
export type ListArenaMessagesQuery = z.output<typeof ListArenaMessagesQuerySchema>;

export interface MessageAuthor {
  type: 'user' | 'agent' | 'system';
  id: string;
  display_name: string;
  /** "RS"; "AI" for the AI. */
  initials: string;
  /** The author's role names in this arena (empty when they have left, or for the AI). */
  roles: string[];
}

/** What arena and private messages share (OpenAPI Message). */
export interface ChatMessage {
  id: string;
  parent_id: string | null;
  author: MessageAuthor;
  /** Plain text, as written (trimmed). */
  body: string;
  /** `event`: a stream card (e.g. a Push to Arena), with the artifact in `artifact_refs`. */
  kind: 'text' | 'agent' | 'event' | 'gate';
  attachments: FileRef[];
  artifact_refs: string[];
  edited_at: string | null;
  /** RFC 3339, UTC, microseconds: sorts as a string. */
  created_at: string;
}

export interface ArenaMessage extends ChatMessage {
  arena_id: string;
}

/** A page of a message stream (arena or private chat). */
export interface ChatMessagePage<M extends ChatMessage = ChatMessage> {
  /** Oldest to newest. */
  items: M[];
  /** Pass as `cursor` for the older page; null when there is none (or with `after`). */
  next_cursor: string | null;
  /** Pass as `after` to poll for newer messages; null while the stream has none. */
  latest_cursor: string | null;
}

export type ArenaMessagePage = ChatMessagePage<ArenaMessage>;

/** An AI turn (OpenAPI Turn). */
export interface ArenaTurn {
  id: string;
  status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  mode: 'prompt' | 'steer' | 'follow_up' | 'system' | 'routine' | 'assignment';
  failure_code: string | null;
  queued_at: string;
  finished_at: string | null;
}

/** failure_code when no agent runtime is configured or reachable: "AI isn't connected yet". */
export const AI_NOT_CONNECTED_CODES: readonly string[] = [
  'RUNTIME_NOT_CONFIGURED',
  'RUNTIME_UNREACHABLE',
];

/** Why a message that mentions @AI started no turn. */
export interface AiSkipped {
  reason: 'not_allowed' | 'rate_limited';
  detail: string;
}

/**
 * POST response (OpenAPI SendMessageResult). `turn` is set when the message mentions @AI and the
 * sender may invoke it; otherwise null, with `ai_skipped` saying why when @AI was mentioned.
 */
export interface SendMessageResult<M extends ChatMessage = ChatMessage> {
  message: M;
  turn: ArenaTurn | null;
  ai_skipped?: AiSkipped;
}

export type SendArenaMessageResult = SendMessageResult<ArenaMessage>;

/** One `data:` frame of GET /projects/{id}/arena/turns/{turn_id}/events (text/event-stream). */
export type ArenaTurnStreamEvent =
  | { type: 'delta'; text: string }
  | {
      type: 'status';
      status: ArenaTurn['status'];
      failure_code: string | null;
      /** The AI's message once the turn completed with one. */
      message_id: string | null;
    };

/** Whether a message asks the AI: "@AI" as a word, any case ("@ai," yes; "x@ai.com", "@aim" no). */
export function mentionsAi(body: string): boolean {
  return /(?<![\w@.])@ai(?![\w-]|\.\w)/i.test(body);
}

export interface ProjectMember {
  user_id: string;
  display_name: string;
  initials: string;
  email: string;
  roles: { id: string; name: string }[];
  is_owner: boolean;
  added_at: string;
}

export interface ProjectMemberList {
  items: ProjectMember[];
  /** What you can do here. */
  viewer: { user_id: string; can_post: boolean };
}
