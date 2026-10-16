import { z } from 'zod';
import type { ChatMessage } from './messages.js';

// Private chats and private projects (build step 5, ADR-034; openapi_v2.yaml listPrivateSessions,
// createPrivateSession, renamePrivateSession, deletePrivateSession, listPrivateMessages,
// sendPrivateMessage, and the additive /private/projects paths). Private belongs to no arena: only
// its owner ever sees it.

export const CHAT_TITLE_MAX_CHARS = 120;
export const PROJECT_NAME_MAX_CHARS = 80;
export const CHAT_LIST_MAX = 200;
export const CHAT_LIST_DEFAULT = 100;
/** The org uuid of every Private runtime session (RIC session_key and scope.org_id, ADR-034). */
export const PRIVATE_ORG_ID = '00000000-0000-0000-0000-000000000000';

const Uuid = z
  .string()
  .uuid('Must be a uuid')
  .transform((id) => id.toLowerCase());

const ChatTitle = z
  .string()
  .trim()
  .min(1, 'Give the chat a name')
  .max(CHAT_TITLE_MAX_CHARS, `At most ${CHAT_TITLE_MAX_CHARS} characters`);

const ProjectName = z
  .string()
  .trim()
  .min(1, 'Give the project a name')
  .max(PROJECT_NAME_MAX_CHARS, `At most ${PROJECT_NAME_MAX_CHARS} characters`);

/** POST /private/sessions. Binding at creation and model choice come later (strict: rejected). */
export const CreatePrivateChatSchema = z
  .object({
    title: ChatTitle.optional(),
    private_project_id: Uuid.optional(),
  })
  .strict();
export type CreatePrivateChatInput = z.input<typeof CreatePrivateChatSchema>;
export type CreatePrivateChat = z.output<typeof CreatePrivateChatSchema>;

/** PATCH /private/sessions/{id}. */
export const RenamePrivateChatSchema = z.object({ title: ChatTitle }).strict();
export type RenamePrivateChat = z.output<typeof RenamePrivateChatSchema>;

/** PUT /private/sessions/{id}/project: file the chat in a project, or null for Recent. */
export const MovePrivateChatSchema = z.object({ private_project_id: Uuid.nullable() }).strict();
export type MovePrivateChat = z.output<typeof MovePrivateChatSchema>;

/** GET /private/sessions query. `q` matches the title (case-insensitive). */
export const ListPrivateChatsQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int('Must be a whole number')
    .min(1, 'At least 1')
    .max(CHAT_LIST_MAX, `At most ${CHAT_LIST_MAX}`)
    .default(CHAT_LIST_DEFAULT),
  q: z.string().trim().max(200, 'At most 200 characters').optional(),
});
export type ListPrivateChatsQuery = z.output<typeof ListPrivateChatsQuerySchema>;

/** POST/PATCH /private/projects(/{id}). */
export const PrivateProjectNameSchema = z.object({ name: ProjectName }).strict();
export type PrivateProjectName = z.output<typeof PrivateProjectNameSchema>;

/** A private chat (OpenAPI PrivateSession). */
export interface PrivateChat {
  id: string;
  /** Null until named; the first message names it. */
  title: string | null;
  private_project_id: string | null;
  /** The arena this chat is linked to (the bridge, write-once): "Linked to arena · <name>". */
  bound_project: { id: string; key: string; name: string } | null;
  model_class: 'balanced';
  last_message_at: string | null;
  created_at: string;
}

export interface PrivateChatList {
  /** Most recent activity first. */
  items: PrivateChat[];
  next_cursor: null;
}

/** One of your private projects (folders of private chats). */
export interface PrivateProject {
  id: string;
  name: string;
  chat_count: number;
  created_at: string;
}

export interface PrivateProjectList {
  /** Oldest first, like the sidebar. */
  items: PrivateProject[];
}

export interface PrivateMessage extends ChatMessage {
  private_session_id: string;
}

/** The title a chat gets from its first message: the first line, cut at a word near 60 chars. */
export function titleFromMessage(body: string): string {
  const line = body.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (line.length <= 60) return line || 'New chat';
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
