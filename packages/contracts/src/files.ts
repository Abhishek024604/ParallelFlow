import { z } from 'zod';
import type { ArtifactUpstream } from './arena-copy.js';
import type { SdlcStage } from './arenas.js';

// Files, artifacts and the bridge (build step 6, ADR-034; openapi_v2.yaml Artifacts tag and
// bindPrivateSession / pullContext, plus the additive Phase A paths noted in the yaml).
//   * Text artifacts (markdown): private (owner only, no org) or in an arena (project).
//   * Uploads: a file stored as it is and attached to a message (arena or private chat).
//   * The bridge: Push copies one private version into an arena; Bring context links a private chat
//     to one arena, once.

/** UTF-8 bytes of an artifact version (doc 10 §10.5: artifact 2 MB). */
export const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
/** Characters (OpenAPI NewVersion.content maxLength). */
export const ARTIFACT_MAX_CHARS = 2_000_000;
/** One upload (Phase A, in the database; doc 10 says 100 MB once files move to S3). */
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_NAME_MAX_CHARS = 120;
export const FILE_NAME_MAX_CHARS = 255;
/** Files on one message. */
export const MESSAGE_ATTACHMENTS_MAX = 10;

/** Upload allowlist: MIME type → file extensions. Nothing else is accepted (no HTML, no SVG). */
export const UPLOAD_TYPES = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
  'text/markdown': ['md', 'markdown'],
  'text/csv': ['csv'],
  'application/json': ['json'],
} as const satisfies Record<string, readonly string[]>;
export type UploadType = keyof typeof UPLOAD_TYPES;
export const UPLOAD_TYPE_LIST = Object.keys(UPLOAD_TYPES) as UploadType[];

/** Shown inline (as a thumbnail or image); everything else downloads as an attachment. */
export const IMAGE_TYPES: readonly UploadType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export function isUploadType(value: string): value is UploadType {
  return Object.prototype.hasOwnProperty.call(UPLOAD_TYPES, value);
}

/** The allowlisted type for a file name's extension, if any. */
export function uploadTypeForName(name: string): UploadType | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  return UPLOAD_TYPE_LIST.find((type) => (UPLOAD_TYPES[type] as readonly string[]).includes(ext));
}

export const ARTIFACT_KINDS = [
  'goal',
  'spec',
  'plan',
  'test_report',
  'release_notes',
  'progress',
  'stage_summary',
  'diagram',
  'document',
  'code_ref',
  'other',
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** Slashes, backslashes and control characters, which a file name may not contain. */
export function hasUnsafeNameChars(name: string): boolean {
  for (const ch of name) {
    const code = ch.charCodeAt(0);
    if (ch === '/' || ch === '\\' || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const Uuid = z
  .string()
  .uuid('Must be a uuid')
  .transform((id) => id.toLowerCase());

const ArtifactName = z
  .string()
  .trim()
  .min(1, 'Give the file a name')
  .max(ARTIFACT_NAME_MAX_CHARS, `At most ${ARTIFACT_NAME_MAX_CHARS} characters`)
  .refine((name) => !hasUnsafeNameChars(name), 'No slashes or control characters');

const Content = z
  .string()
  .max(ARTIFACT_MAX_CHARS, 'At most 2 MB')
  .refine((text) => utf8Bytes(text) <= ARTIFACT_MAX_BYTES, 'At most 2 MB');

/** POST /artifacts (private) and POST /projects/{id}/artifacts (arena draft). */
export const CreateArtifactSchema = z
  .object({
    scope: z.enum(['private', 'project']),
    kind: z.enum(ARTIFACT_KINDS).default('document'),
    name: ArtifactName,
    content: Content,
    project_id: Uuid.optional(),
    private_session_id: Uuid.optional(),
  })
  .strict();
export type CreateArtifactInput = z.input<typeof CreateArtifactSchema>;
export type CreateArtifact = z.output<typeof CreateArtifactSchema>;

/** POST …/artifacts/{id}/versions. */
export const NewVersionSchema = z
  .object({
    content: Content,
    change_note: z.string().trim().max(500, 'At most 500 characters').optional(),
  })
  .strict();
export type NewVersionInput = z.input<typeof NewVersionSchema>;
export type NewVersion = z.output<typeof NewVersionSchema>;

/**
 * POST /projects/{id}/artifacts/{artifact_id}/approve: the arena owner approves the latest version
 * (named, so a newer version written meanwhile is never approved unseen).
 */
export const ApproveVersionSchema = z.object({ version_no: z.number().int().positive() }).strict();
export type ApproveVersion = z.output<typeof ApproveVersionSchema>;

/** GET /artifacts query (`scope=private`: yours). Arena artifacts: GET /projects/{id}/artifacts. */
export const ListArtifactsQuerySchema = z.object({
  scope: z.enum(['private']).default('private'),
  private_session_id: Uuid.optional(),
});
export type ListArtifactsQuery = z.output<typeof ListArtifactsQuerySchema>;

/** POST /private/sessions/{id}:bind. */
export const BindRequestSchema = z.object({ project_id: Uuid }).strict();
export type BindRequest = z.output<typeof BindRequestSchema>;

export const PULL_CONTEXT_PARTS = [
  'project_brief',
  'artifacts',
  'recent_messages',
  'tasks',
  'previous_cycles',
] as const;

/**
 * POST /private/sessions/{id}/bridge/pull-context. `project_id` (additive) links an unlinked chat in
 * the same call; for a linked chat it must be the linked arena.
 */
export const PullContextSchema = z
  .object({
    include: z.array(z.enum(PULL_CONTEXT_PARTS)).min(1, 'Pick what to bring').max(5),
    artifact_ids: z.array(Uuid).max(50).optional(),
    message_window: z.number().int().min(1).max(200).optional(),
    project_id: Uuid.optional(),
  })
  .strict();
export type PullContextInput = z.input<typeof PullContextSchema>;
export type PullContext = z.output<typeof PullContextSchema>;

/** GET /artifacts/{id}/push-preview query. */
export const PushPreviewQuerySchema = z.object({
  project_id: Uuid.optional(),
  version_no: z.coerce.number().int().min(1).optional(),
});
export type PushPreviewQuery = z.output<typeof PushPreviewQuerySchema>;

/** POST /artifacts/{id}/push. `request_gate`: also request the current stage's gate (cap stage.request_gate). */
export const PushRequestSchema = z
  .object({
    project_id: Uuid,
    version_no: z.number().int().min(1),
    mode: z.enum(['auto', 'new', 'new_version']).default('auto'),
    attach_to_active_cycle: z.boolean().optional(),
    request_gate: z.boolean().optional(),
    notify_members: z.literal(false, { message: 'Notifying members is coming soon' }).optional(),
    /** The file's standard name in the arena (ADR-038); defaults to PushPreview.arena_name. */
    name: z.string().trim().min(1).max(120).optional(),
    /**
     * A copy of an arena file whose arena file has a newer version than the one copied (ADR-041):
     * true replaces it with yours (as a new version); without it the push is 409 CONFLICT.
     */
    replace_newer: z.boolean().optional(),
  })
  .strict();
export type PushRequestInput = z.input<typeof PushRequestSchema>;
export type PushRequest = z.output<typeof PushRequestSchema>;

/** POST /private/files and POST /projects/{id}/files query (the body is the raw file). */
export const UploadQuerySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'The file needs a name')
    .max(FILE_NAME_MAX_CHARS, `At most ${FILE_NAME_MAX_CHARS} characters`),
  mime_type: z.string().refine(isUploadType, 'This file type is not allowed'),
});
export type UploadQuery = z.output<typeof UploadQuerySchema>;

/** An uploaded file (OpenAPI Message.attachments item). */
export interface FileRef {
  file_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
}

/** OpenAPI Artifact (plus additive size / updated fields for the file list). */
export interface Artifact {
  id: string;
  lineage_id: string;
  scope: 'private' | 'project';
  kind: ArtifactKind;
  name: string;
  /** The SDLC stage an arena file belongs to (set when it is created); null for private files. */
  stage?: SdlcStage | null;
  project_id: string | null;
  private_session_id: string | null;
  head_version_no: number;
  approved_version_no: number | null;
  size_bytes: number;
  created_at: string;
  updated_at: string;
  /** Who wrote the latest version: "Asha", "AI for Asha" or "AI". */
  last_author?: string | null;
  /** Private copies of an arena file (ADR-041): where it came from. */
  upstream?: ArtifactUpstream | null;
}

export interface ArtifactList {
  /** Most recently updated first. */
  items: Artifact[];
  next_cursor: null;
}

/** OpenAPI ArtifactVersion. */
export interface ArtifactVersion {
  version_no: number;
  status: 'draft' | 'in_review' | 'approved' | 'superseded' | 'discarded';
  blob_sha256: string;
  size_bytes: number;
  change_note: string | null;
  created_by: { type: 'user' | 'agent' | 'service'; id: string; display_name: string };
  approved_by: string | null;
  /** The approver's display name, when approved. */
  approved_by_name?: string | null;
  approved_at?: string | null;
  /** Where it came from, resolved for display (never the private file or chat ids). */
  source: ArtifactVersionSource | null;
  created_at: string;
  /** Private versions only (owner): where this version was pushed, newest first. */
  pushed_to?: PushedTo[];
}

/** A person on a version row. */
export interface VersionPerson {
  id: string;
  display_name: string;
}

/** ArtifactVersion.source: {type: private_session|arena_turn|private_turn|push|upload|progress_log|activity_log|state_log}. */
export interface ArtifactVersionSource {
  type: string;
  /** Plain words: "Pushed from Private v3 by Asha", "Written by AI for Asha", "Uploaded by Asha". */
  label?: string;
  /** Pushes: the version came from the pusher's Private space. */
  from?: 'private';
  /** Pushes: the Private version number it was copied from (numbering is per space). */
  private_version_no?: number;
  /** Pushes: who pushed it. */
  pushed_by?: VersionPerson;
  /** Arena copies (private versions): "Copied from <arena> · <file> v3". */
  copied_from?: { arena_name: string | null; name: string | null; version_no: number };
}

/** What a version's author and origin read as, in plain words (viewer, App Tools). */
export interface AuthorFacts {
  /** source_ref.type, if any. */
  sourceType: string | null;
  authorType: 'user' | 'agent' | 'service';
  /** The person's display name (user authors). */
  authorName: string | null;
  /** Agent authors: the person whose message started the turn (arena turns). */
  onBehalfOfName: string | null;
  versionNo: number;
  /** Pushes: the Private version it was copied from. */
  privateVersionNo?: number | null;
}

/** "Asha", "AI for Asha", "AI". */
export function authorLabel(f: AuthorFacts): string {
  if (f.authorType === 'user') return f.authorName ?? 'Former teammate';
  return f.onBehalfOfName ? `AI for ${f.onBehalfOfName}` : 'AI';
}

/** "Pushed from Private v3 by Asha", "Written by AI for Asha", "Uploaded by Asha", "Edited by Asha". */
export function sourceLabel(f: AuthorFacts): string {
  const who = authorLabel(f);
  if (f.sourceType === 'push') {
    const from = f.privateVersionNo ? `Private v${f.privateVersionNo}` : 'Private';
    return `Pushed from ${from} by ${who}`;
  }
  if (f.sourceType === 'arena_copy') return `Copied from an arena by ${who}`;
  if (f.sourceType === 'progress_log') return 'Project log, kept from the record';
  if (f.sourceType === 'activity_log') return 'Activity log, kept from the arena’s events';
  if (f.sourceType === 'state_log') return 'Written by AI (arena summary)';
  if (f.sourceType === 'memory_story') return 'Written by AI each night (the arena’s story)';
  if (f.authorType !== 'user') return `Written by ${who}`;
  if (f.sourceType === 'upload') return `${f.versionNo === 1 ? 'Uploaded' : 'Edited'} by ${who}`;
  return `${f.versionNo === 1 ? 'Written' : 'Edited'} by ${who}`;
}

/** "18 Oct 2026, 14:05 UTC": dates for the AI and server text, never raw ISO. */
export function plainDateTime(value: Date | string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const month = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][d.getUTCMonth()];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/** One push of a private version into an arena (owner only). */
export interface PushedTo {
  arena_name: string;
  project_id: string;
  arena_version_no: number;
  pushed_at: string;
}

export interface ArtifactVersionList {
  /** Newest first. */
  items: ArtifactVersion[];
}

/** OpenAPI PushPreview (plus the line counts behind `diff_summary`). */
export interface PushPreview {
  destination: { project_id: string; key: string; name: string } | null;
  /** True when the chat is linked: the destination cannot change. */
  destination_locked: boolean;
  mode: 'new' | 'new_version';
  existing_artifact_id: string | null;
  existing_version_no: number | null;
  diff: { added: number; removed: number } | null;
  diff_summary: string | null;
  will_share: string[];
  /** The standard name the file takes in the arena (ADR-038); null until an arena is chosen. */
  arena_name: string | null;
  binds_session: boolean;
  /** The stage whose gate you could request with this push; null when you cannot (or one is open). */
  gate_available: { stage: SdlcStage; cycle_number: number } | null;
  version: { version_no: number; size_bytes: number; created_at: string };
  /** Arenas you may push to (cap artifact.push); just the linked one when linked. */
  arenas: { project_id: string; key: string; name: string }[];
  /**
   * A copy of a file of this arena (ADR-041): the push adds a version to that same file. `newer`:
   * the arena file moved on since the copy, so the push needs `replace_newer` (the diff below is the
   * arena's latest version → yours).
   */
  upstream: {
    artifact_id: string;
    name: string;
    copied_version_no: number;
    arena_version_no: number;
    newer: boolean;
  } | null;
  /** Line diff, the arena file's latest version → yours; only when `upstream.newer`. */
  upstream_diff: DiffLine[] | null;
  /** True when `upstream_diff` was cut short. */
  upstream_diff_truncated: boolean;
}

/** One line of a line diff: kept (' '), added ('+') or removed ('-'). */
export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** OpenAPI PushResult. */
export interface PushResult {
  artifact_id: string;
  version_no: number;
  mode: 'new' | 'new_version';
  /** The gate request made with the push (`request_gate`). */
  approval_id: string | null;
  session_bound: boolean;
  /** The stream card, when you can post in the arena. */
  message_id: string | null;
}

/** A linked arena of a private chat ("Linked to arena · <name>"). */
export interface LinkedArena {
  id: string;
  key: string;
  name: string;
}

/** Diff wording for the push preview: "+12 / −3 lines". */
export function diffSummary(diff: { added: number; removed: number } | null): string | null {
  if (!diff) return null;
  if (diff.added === 0 && diff.removed === 0) return 'No changes';
  return `+${diff.added} / −${diff.removed} lines`;
}

/** "12 KB", "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
