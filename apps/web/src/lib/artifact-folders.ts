import type { Artifact, SdlcStage } from '@parallelflow/contracts';
import { ARCH_STATE_NAME, SDLC_STAGES, stageOfFileName } from '@parallelflow/contracts';

// Arena files are filed in one folder per SDLC stage, in loop order, with no sub-folders. A file's
// folder comes from its standard name (plan.md → Plan, lld-auth.md → Design, test-e2e.md → Test;
// @parallelflow/contracts file-names.ts). Files saved before the naming rule fall back to the stage
// they were created in, then to their kind, else Plan. The arena's two logs, PROGRESS.md and
// STATE.md, cover the whole arena rather than one stage: they sit above the folders, in that order.
// SWA's own state document is not shown.

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

export interface StageFolder {
  stage: SdlcStage;
  label: string;
  files: Artifact[];
}

/** Every stage folder in loop order (empty ones included), each keeping the list's order. */
export function groupByStage(items: Artifact[]): StageFolder[] {
  const files = items.filter((a) => !isArenaLog(a) && !isHidden(a));
  return SDLC_STAGES.map((stage) => ({
    stage,
    label: STAGE_FOLDER_LABEL[stage],
    files: files.filter((a) => stageOf(a) === stage),
  }));
}

/** Files people see in the arena (everything except SWA's state document). */
export const visibleCount = (items: Artifact[]): number => items.filter((a) => !isHidden(a)).length;
