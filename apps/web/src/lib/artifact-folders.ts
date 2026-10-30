import type { Artifact, SdlcStage } from '@parallelflow/contracts';
import {
  ARCH_SEPARATOR,
  ARCH_STATE_NAME,
  archPathOf,
  parseFileName,
  SDLC_STAGES,
  stageOfFileName,
} from '@parallelflow/contracts';
import { ARCH_FOLDERS } from './chat-files';

// Arena files are filed in one folder per SDLC stage, in loop order. A file's folder comes from its
// standard name (plan.md → Plan, lld-auth.md → Design, test-e2e.md → Test; @parallelflow/contracts
// file-names.ts). Files saved before the naming rule fall back to the stage they were created in,
// then to their kind, else Plan. Inside a stage folder, a name's own folders make subfolders
// ("Backlog › requirements-story-001.md" → Plan › Backlog), and SWA's files sit in their
// architecture folders (lld-CMP-001.md → Design › LLD › CMP-001). The arena's two logs,
// PROGRESS.md and STATE.md, cover the whole arena rather than one stage: they sit above the folders,
// in that order. SWA's own state document is not shown.

/** PROGRESS.md (the `progress` artifact), then STATE.md (`stage_summary`). */
const ARENA_LOG_KINDS: readonly Artifact['kind'][] = ['progress', 'stage_summary'];

const isArenaLog = (a: Pick<Artifact, 'kind'>) => ARENA_LOG_KINDS.includes(a.kind);
const isHidden = (a: Pick<Artifact, 'name'>) => a.name === ARCH_STATE_NAME;

/** The arena-wide logs, pinned above the stage folders: PROGRESS.md first, then STATE.md. */
export function arenaLogs(items: Artifact[]): Artifact[] {
  return items
    .filter(isArenaLog)
    .sort((a, b) => ARENA_LOG_KINDS.indexOf(a.kind) - ARENA_LOG_KINDS.indexOf(b.kind));
}

export const STAGE_FOLDER_LABEL: Record<SdlcStage, string> = {
  PLAN: 'Plan',
  DESIGN: 'Design',
  BUILD: 'Build',
  TEST: 'Test',
  DEPLOY: 'Deploy',
  MAINTAIN: 'Maintain',
};

const KIND_STAGE: Partial<Record<Artifact['kind'], SdlcStage>> = {
  goal: 'PLAN',
  spec: 'PLAN',
  plan: 'PLAN',
  diagram: 'DESIGN',
  code_ref: 'BUILD',
  test_report: 'TEST',
  release_notes: 'DEPLOY',
};

export function stageOf(a: Pick<Artifact, 'stage' | 'kind' | 'name'>): SdlcStage {
  return stageOfFileName(a.name) ?? a.stage ?? KIND_STAGE[a.kind] ?? 'PLAN';
}

/** SWA folders that a stage folder already says, or that hold the arena's top documents. */
const FLAT_ARCH_ROOTS = new Set(['inputs', '.swa']);

/** The subfolders a file sits in inside its stage folder, outermost first ([] at the top). */
export function arenaFolders(name: string): string[] {
  const parsed = parseFileName(name);
  if (parsed && parsed.folders.length > 0) return parsed.folders;
  if (name.includes(ARCH_SEPARATOR) || name === 'hld.md') return [];
  const parts = archPathOf(name)?.split('/') ?? [];
  parts.pop();
  if (parts.length === 0 || FLAT_ARCH_ROOTS.has(parts[0] ?? '')) return [];
  return parts.map((p) => ARCH_FOLDERS[p] ?? p);
}

/** The name shown in its folder: "Backlog › requirements-x.md" → "requirements-x.md". */
export const arenaLeaf = (name: string): string => parseFileName(name)?.leaf ?? name;

export interface ArenaSubfolder {
  name: string;
  /** "HLD › Flows": unique inside its stage folder. */
  path: string;
  folders: ArenaSubfolder[];
  files: Artifact[];
}

/** A stage folder's files as a tree: subfolders A–Z, files keep the given order. */
export function arenaTree(files: readonly Artifact[]): ArenaSubfolder {
  const root: ArenaSubfolder = { name: '', path: '', folders: [], files: [] };
  for (const a of files) {
    let node = root;
    for (const name of arenaFolders(a.name)) {
      let next = node.folders.find((f) => f.name === name);
      if (!next) {
        const path = node.path ? `${node.path}${ARCH_SEPARATOR}${name}` : name;
        next = { name, path, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push(a);
  }
  const sort = (node: ArenaSubfolder) => {
    node.folders.sort((x, y) => x.name.localeCompare(y.name));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Files in a subfolder, its own subfolders included. */
export const subfolderCount = (f: ArenaSubfolder): number =>
  f.files.length + f.folders.reduce((n, c) => n + subfolderCount(c), 0);

export interface StageFolder {
  stage: SdlcStage;
  label: string;
  files: Artifact[];
  /** The same files in their subfolders. */
  tree: ArenaSubfolder;
}

/** Every stage folder in loop order (empty ones included), each keeping the list's order. */
export function groupByStage(items: Artifact[]): StageFolder[] {
  const files = items.filter((a) => !isArenaLog(a) && !isHidden(a));
  return SDLC_STAGES.map((stage) => {
    const inStage = files.filter((a) => stageOf(a) === stage);
    return { stage, label: STAGE_FOLDER_LABEL[stage], files: inStage, tree: arenaTree(inStage) };
  });
}

/** Files people see in the arena (everything except SWA's state document). */
export const visibleCount = (items: Artifact[]): number => items.filter((a) => !isHidden(a)).length;
