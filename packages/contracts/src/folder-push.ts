import { z } from 'zod';
import { upstreamDecision } from './arena-copy.js';
import type { SdlcStage } from './arenas.js';
import { arenaNameForPush, uniqueFileName } from './file-names.js';

// Push a folder to an arena: the files of one private folder go to the arena in one push, kept as
// a folder. Each file gets a unique standard name inside the arena folders of its private folders
// ("pm › backlog › STORY-001.md" → "Backlog › requirements-story-001.md"); a file pushed before (the
// same lineage, or a copy of that arena file, ADR-041) gets a new version of that file, and only
// when its content changed. One transaction, one bridge event and one arena card for the batch.
//   POST /private/sessions/{id}/bridge/push-folder/preview   what would happen (no writes)
//   POST /private/sessions/{id}/bridge/push-folder           the push (Idempotency-Key)

/** Files in one folder push, at most. */
export const FOLDER_PUSH_MAX_FILES = 200;

const Uuid = z
  .string()
  .uuid('Must be a uuid')
  .transform((id) => id.toLowerCase());

const ArtifactIds = z
  .array(Uuid)
  .min(1, 'Pick at least one file')
  .max(FOLDER_PUSH_MAX_FILES, `At most ${FOLDER_PUSH_MAX_FILES} files at a time`)
  .refine((ids) => new Set(ids).size === ids.length, 'Each file only once');

/** The folder as the private tree shows it ("Architecture", "pm › backlog"): the card's label. */
const FolderLabel = z.string().trim().min(1, 'Pick a folder').max(200, 'At most 200 characters');

export const PushFolderPreviewSchema = z
  .object({
    project_id: Uuid.optional(),
    folder: FolderLabel,
    artifact_ids: ArtifactIds,
  })
  .strict();
export type PushFolderPreviewInput = z.input<typeof PushFolderPreviewSchema>;
export type PushFolderPreviewRequest = z.output<typeof PushFolderPreviewSchema>;

export const PushFolderSchema = z
  .object({
    project_id: Uuid,
    folder: FolderLabel,
    artifact_ids: ArtifactIds,
    /** Also request the current stage's gate (cap stage.request_gate), as with one file. */
    request_gate: z.boolean().optional(),
    /** Copies whose arena file moved on since the copy (ADR-041): replace with yours. */
    replace_newer: z.boolean().optional(),
  })
  .strict();
export type PushFolderInput = z.input<typeof PushFolderSchema>;
export type PushFolder = z.output<typeof PushFolderSchema>;

export type FolderPushAction = 'new' | 'new_version' | 'unchanged';

/** One file of a folder push. */
export interface FolderPushItem {
  /** The private file. */
  artifact_id: string;
  version_no: number;
  private_name: string;
  /** Its standard name in the arena (folders included). */
  arena_name: string;
  action: FolderPushAction;
  /** The arena file it adds a version to (new_version, unchanged). */
  existing_artifact_id: string | null;
  existing_version_no: number | null;
  /** A copy whose arena file moved on since the copy: needs `replace_newer`. */
  newer: boolean;
}

export interface PushFolderPreview {
  destination: { project_id: string; key: string; name: string } | null;
  /** True when the chat is linked: the destination cannot change. */
  destination_locked: boolean;
  /** Arenas you may push to (cap artifact.push); just the linked one when linked. */
  arenas: { project_id: string; key: string; name: string }[];
  folder: string;
  /** Empty until an arena is chosen. */
  files: FolderPushItem[];
  counts: Record<FolderPushAction, number>;
  binds_session: boolean;
  gate_available: { stage: SdlcStage; cycle_number: number } | null;
}

export interface PushFolderResult {
  project_id: string;
  folder: string;
  /** The arena files, in the order pushed (unchanged ones included). */
  files: { artifact_id: string; name: string; version_no: number; action: FolderPushAction }[];
  counts: Record<FolderPushAction, number>;
  approval_id: string | null;
  session_bound: boolean;
  /** The arena card for the batch (none when nothing changed or you cannot post). */
  message_id: string | null;
}

// ---------------------------------------------------------------- the plan (pure)

/** A private file of the folder (its head version). */
export interface FolderPushSource {
  artifact_id: string;
  version_no: number;
  name: string;
  lineage_id: string;
  /** Content hash of the version pushed. */
  sha256: string;
  upstream?: { project_id: string; artifact_id: string; version_no: number } | null;
}

/** A file in the arena now (not deleted), most recently updated first. */
export interface FolderPushArenaFile {
  id: string;
  name: string;
  lineage_id: string;
  head_version_no: number;
  /** Content hash of its head version. */
  sha256: string;
}

/**
 * What a folder push does with each file, in the given order:
 *   1. a copy of an arena file of this arena (ADR-041) goes back to that file;
 *   2. else a file pushed before (same lineage) goes to the arena file it became;
 *   3. else it gets a name (arenaNameForPush, with a suffix from its own name, unique in the arena
 *      and the batch); a standard name that already exists adds a version to that file.
 * A file whose content is the arena file's head is `unchanged`. Two files never share a target.
 */
export function planFolderPush(input: {
  projectId: string;
  stage: SdlcStage;
  sources: readonly FolderPushSource[];
  arenaFiles: readonly FolderPushArenaFile[];
}): FolderPushItem[] {
  const taken = new Set(input.arenaFiles.map((f) => f.name));
  const claimed = new Set<string>();
  const free = (f: FolderPushArenaFile | undefined) => (f && !claimed.has(f.id) ? f : undefined);
  const items: FolderPushItem[] = [];
  for (const s of input.sources) {
    const byId = (id: string) => input.arenaFiles.find((f) => f.id === id);
    const up = s.upstream
      ? upstreamDecision({
          upstream: s.upstream,
          projectId: input.projectId,
          arenaFile: byId(s.upstream.artifact_id) ?? null,
        })
      : ({ kind: 'none' } as const);
    let target =
      up.kind === 'same_file'
        ? free(byId(up.artifact_id))
        : free(input.arenaFiles.find((f) => f.lineage_id === s.lineage_id));
    let name = target?.name ?? '';
    if (!target) {
      name = arenaNameForPush(s.name, { stage: input.stage, taken, alwaysSuffix: true });
      target = free(input.arenaFiles.find((f) => f.name === name));
      // A standard name another file of this batch already took.
      if (!target && taken.has(name)) name = uniqueFileName(name, taken);
    }
    if (target) claimed.add(target.id);
    taken.add(name);
    items.push({
      artifact_id: s.artifact_id,
      version_no: s.version_no,
      private_name: s.name,
      arena_name: name,
      action: !target ? 'new' : target.sha256 === s.sha256 ? 'unchanged' : 'new_version',
      existing_artifact_id: target?.id ?? null,
      existing_version_no: target?.head_version_no ?? null,
      newer: up.kind === 'same_file' && target?.id === up.artifact_id && up.newer,
    });
  }
  return items;
}

export function countActions(items: readonly { action: FolderPushAction }[]) {
  const counts: Record<FolderPushAction, number> = { new: 0, new_version: 0, unchanged: 0 };
  for (const i of items) counts[i.action] += 1;
  return counts;
}

/** The batch card: "Asha pushed Architecture · 14 files from Private". */
export function folderPushCard(who: string, folder: string, files: number): string {
  return `${who} pushed ${folder} · ${files} ${files === 1 ? 'file' : 'files'} from Private`;
}
