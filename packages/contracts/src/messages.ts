import { z } from 'zod';

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

/** POST /projects/{project_id}/arena/messages body. Attachments and artifact refs come later. */
export const SendArenaMessageSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, 'Write a message first')
      .max(MESSAGE_BODY_MAX_CHARS, `At most ${MESSAGE_BODY_MAX_CHARS} characters`)
      .refine((text) => utf8Bytes(text) <= MESSAGE_BODY_MAX_BYTES, 'At most 20 KB'),
    parent_id: Uuid.optional(),
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

export interface ArenaMessage {
  id: string;
  arena_id: string;
  parent_id: string | null;
  author: MessageAuthor;
  /** Plain text, as written (trimmed). */
  body: string;
  kind: 'text' | 'agent';
  edited_at: string | null;
  /** RFC 3339, UTC, microseconds: sorts as a string. */
  created_at: string;
}

export interface ArenaMessagePage {
  /** Oldest to newest. */
  items: ArenaMessage[];
  /** Pass as `cursor` for the older page; null when there is none (or with `after`). */
  next_cursor: string | null;
  /** Pass as `after` to poll for newer messages; null while the arena has none. */
  latest_cursor: string | null;
}

/** POST response (OpenAPI SendMessageResult); `turn` arrives with the AI in step 4. */
export interface SendArenaMessageResult {
  message: ArenaMessage;
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
