import { z } from 'zod';
import { ARCH_SEPARATOR } from './arch-docs.js';
import { ARTIFACT_NAME_MAX_CHARS, hasUnsafeNameChars } from './files.js';

// Arena → Private copies (ADR-041), file moves in Private, and the drag payload of the web app.
//   * Copy: an arena file's version becomes a private file in one of your chats linked to that
//     arena (or a new chat linked to it). The copy remembers its upstream (arena, file, version);
//     pushing it back adds a version to that same arena file, after a warning when the arena file
//     moved on since.
//   * Moves: a private file changes folder (the " › " part of its name) or chat; ids and versions stay.
//   * Drag and drop carries ids (and a folder path), never content.

export const FOLDER_SEPARATOR = ARCH_SEPARATOR;

const Uuid = z
  .string()
  .uuid('Must be a uuid')
  .transform((id) => id.toLowerCase());

const ArtifactIds = z
  .array(Uuid)
  .min(1, 'Pick a file')
  .max(20, 'At most 20 files at once')
  .transform((ids) => [...new Set(ids)]);

/** POST /private/sessions/{id}/bridge/copy-from-arena: copy arena files into this chat. */
export const CopyFromArenaSchema = z
  .object({ project_id: Uuid, artifact_ids: ArtifactIds })
  .strict();
export type CopyFromArena = z.output<typeof CopyFromArenaSchema>;
export type CopyFromArenaInput = z.input<typeof CopyFromArenaSchema>;

/**
 * POST /private/sessions:from-arena: a new chat linked to the arena, with these files copied in, or
 * (`approval_id`, the stage handoff) the files approved with that gate.
 */
export const ChatFromArenaSchema = z
  .object({
    project_id: Uuid,
    artifact_ids: ArtifactIds.optional(),
    approval_id: Uuid.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.artifact_ids) !== Boolean(v.approval_id), {
    message: 'Pick files, or open a stage handoff',
    path: ['artifact_ids'],
  });
export type ChatFromArena = z.output<typeof ChatFromArenaSchema>;
export type ChatFromArenaInput = z.input<typeof ChatFromArenaSchema>;

/** One private copy made by a copy request. */
export interface ArenaCopy {
  /** The private file (new, or the copy you already had in this chat, with a new version). */
  artifact_id: string;
  name: string;
  version_no: number;
  /** The arena file and the version copied. */
  source_artifact_id: string;
  source_version_no: number;
}

export interface CopyFromArenaResult {
  chat_id: string;
  /** True when this request linked the chat to the arena. */
  linked: boolean;
  copies: ArenaCopy[];
}

/** Where a private copy came from (Artifact.upstream; owner only). */
export interface ArtifactUpstream {
  project_id: string;
  /** The arena's name (null when you are no longer a member). */
  arena_name: string | null;
  artifact_id: string;
  /** The arena file's name. */
  name: string | null;
  /** The arena version the copy was made from, or last pushed back as. */
  version_no: number;
}

/** "Copied from Checkout · plan.md v3". */
export function copiedFromLabel(u: {
  arena_name: string | null;
  name: string | null;
  version_no: number;
}): string {
  return `Copied from ${u.arena_name ?? 'an arena'} · ${u.name ?? 'a file'} v${u.version_no}`;
}

/**
 * What pushing a private file to `projectId` does with its upstream (pure): add a version to the
 * same arena file, warning first when that file has a newer version than the one copied; or a
 * normal push when the copy came from elsewhere (or not from an arena at all, or the file is gone).
 */
export type UpstreamDecision =
  | { kind: 'none' }
  | {
      kind: 'same_file';
      artifact_id: string;
      copied_version_no: number;
      arena_version_no: number;
      /** The arena file moved on since the copy: confirm "Replace with mine" first. */
      newer: boolean;
    };

export function upstreamDecision(input: {
  upstream: { project_id: string; artifact_id: string; version_no: number } | null;
  projectId: string;
  /** The upstream arena file now (its head), or null when it is gone or unreadable. */
  arenaFile: { id: string; head_version_no: number } | null;
}): UpstreamDecision {
  const { upstream, arenaFile } = input;
  if (!upstream || upstream.project_id !== input.projectId) return { kind: 'none' };
  if (!arenaFile || arenaFile.id !== upstream.artifact_id) return { kind: 'none' };
  return {
    kind: 'same_file',
    artifact_id: arenaFile.id,
    copied_version_no: upstream.version_no,
    arena_version_no: arenaFile.head_version_no,
    newer: arenaFile.head_version_no > upstream.version_no,
  };
}

// ---------------------------------------------------------------- moves (folders and chats)

const FolderPath = z
  .string()
  .max(ARTIFACT_NAME_MAX_CHARS, `At most ${ARTIFACT_NAME_MAX_CHARS} characters`)
  .transform((p) => normalizeFolder(p))
  .refine((p) => !hasUnsafeNameChars(p), 'No slashes or control characters');

/** PATCH /artifacts/{id}: rename (the folder is the " › " part) and/or move to another chat. */
export const UpdateArtifactSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Give the file a name')
      .max(ARTIFACT_NAME_MAX_CHARS, `At most ${ARTIFACT_NAME_MAX_CHARS} characters`)
      .refine((name) => !hasUnsafeNameChars(name), 'No slashes or control characters')
      .transform((name) => normalizeFolder(name))
      .refine((name) => name !== '', 'Give the file a name')
      .optional(),
    /** Another of your chats, or null for My files only. */
    private_session_id: Uuid.nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.private_session_id !== undefined, 'Nothing to change');
export type UpdateArtifact = z.output<typeof UpdateArtifactSchema>;
export type UpdateArtifactInput = z.input<typeof UpdateArtifactSchema>;

/**
 * POST /artifacts:rename-folder: every file under folder `from` moves under `to` ('' = the top
 * level), in one transaction. `private_session_id`: only that chat's files; omitted: all of yours.
 */
export const RenameFolderSchema = z
  .object({
    from: FolderPath.refine((p) => p !== '', 'Pick a folder'),
    to: FolderPath,
    private_session_id: Uuid.nullable().optional(),
  })
  .strict();
export type RenameFolder = z.output<typeof RenameFolderSchema>;
export type RenameFolderInput = z.input<typeof RenameFolderSchema>;

export interface RenameFolderResult {
  renamed: number;
}

/** Trims each " › " part and drops empty ones: " a ›  › b " → "a › b". */
export function normalizeFolder(path: string): string {
  return path
    .split('›')
    .map((p) => p.trim())
    .filter(Boolean)
    .join(FOLDER_SEPARATOR);
}

/** "pm › backlog › STORY-1.md" → "STORY-1.md". */
export function baseName(name: string): string {
  const parts = name.split(FOLDER_SEPARATOR);
  return parts[parts.length - 1] ?? name;
}

/** The folder part of a name: "pm › backlog › STORY-1.md" → "pm › backlog". */
export function folderOf(name: string): string {
  const parts = name.split(FOLDER_SEPARATOR);
  return parts.slice(0, -1).join(FOLDER_SEPARATOR);
}

/** The name a file takes in `folder` ('' = top level). */
export function nameInFolder(name: string, folder: string): string {
  const f = normalizeFolder(folder);
  return f ? `${f}${FOLDER_SEPARATOR}${baseName(name)}` : baseName(name);
}

export type FolderRenameError = 'SAME_PLACE' | 'INTO_ITSELF' | 'EMPTY' | 'TOO_LONG';

/**
 * The renames that move folder `from` under the new path `to` (pure; the API runs them in one
 * transaction). Files directly in or below `from` keep the rest of their path.
 */
export function planFolderRename(
  files: readonly { id: string; name: string }[],
  from: string,
  to: string,
):
  | { ok: true; renames: { id: string; from: string; to: string }[] }
  | { ok: false; error: FolderRenameError } {
  const src = normalizeFolder(from);
  const dst = normalizeFolder(to);
  if (src === dst) return { ok: false, error: 'SAME_PLACE' };
  if (dst === src || dst.startsWith(`${src}${FOLDER_SEPARATOR}`)) {
    return { ok: false, error: 'INTO_ITSELF' };
  }
  const prefix = `${src}${FOLDER_SEPARATOR}`;
  const renames = files
    .filter((f) => f.name.startsWith(prefix))
    .map((f) => {
      const rest = f.name.slice(prefix.length);
      return { id: f.id, from: f.name, to: dst ? `${dst}${FOLDER_SEPARATOR}${rest}` : rest };
    });
  if (renames.length === 0) return { ok: false, error: 'EMPTY' };
  if (renames.some((r) => r.to.length > ARTIFACT_NAME_MAX_CHARS)) {
    return { ok: false, error: 'TOO_LONG' };
  }
  return { ok: true, renames };
}

// ---------------------------------------------------------------- drag and drop payload

/** The web app's drag type: ids and a folder path only, never content. */
export const FILE_DRAG_TYPE = 'application/x-parallelflow-file';

export const FileDragPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('private'),
    artifact_id: Uuid,
    chat_id: Uuid.nullable(),
  }),
  z.object({
    kind: z.literal('folder'),
    /** The chat whose panel it was dragged from; null from My files (all your files). */
    chat_id: Uuid.nullable(),
    path: z.string().min(1).max(ARTIFACT_NAME_MAX_CHARS),
  }),
  z.object({
    kind: z.literal('arena'),
    project_id: Uuid,
    artifact_id: Uuid,
  }),
]);
export type FileDragPayload = z.output<typeof FileDragPayloadSchema>;

export function encodeDragPayload(payload: FileDragPayload): string {
  return JSON.stringify(payload);
}

/** The payload of a drop, or null when it is not one of ours (or malformed). */
export function parseDragPayload(raw: string | null | undefined): FileDragPayload | null {
  if (!raw || raw.length > 2000) return null;
  try {
    const parsed = FileDragPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
