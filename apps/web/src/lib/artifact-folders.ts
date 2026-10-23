import type { Artifact, SdlcStage } from '@parallelflow/contracts';
import { SDLC_STAGES } from '@parallelflow/contracts';

// Arena files are filed in one folder per SDLC stage, in loop order. Design also has sub-folders
// (HLD, LLD, Architecture, UI). A file's stage is the one it was created in; older files without one
// are placed by kind, then by name, else under Plan.

export type DesignFolder = 'hld' | 'lld' | 'architecture' | 'ui';

export const STAGE_FOLDER_LABEL: Record<SdlcStage, string> = {
  PLAN: 'Plan',
  DESIGN: 'Design',
  BUILD: 'Build',
  TEST: 'Test',
  DEPLOY: 'Deploy',
  MAINTAIN: 'Maintain',
};

export const DESIGN_FOLDERS: { key: DesignFolder; label: string }[] = [
  { key: 'hld', label: 'HLD' },
  { key: 'lld', label: 'LLD' },
  { key: 'architecture', label: 'Architecture' },
  { key: 'ui', label: 'UI' },
];

const KIND_STAGE: Partial<Record<Artifact['kind'], SdlcStage>> = {
  goal: 'PLAN',
  spec: 'PLAN',
  plan: 'PLAN',
  diagram: 'DESIGN',
  code_ref: 'BUILD',
  test_report: 'TEST',
  release_notes: 'DEPLOY',
};

const NAME_STAGE: [RegExp, SdlcStage][] = [
  [/\b(hld|lld|design|architecture|arch|wireframe|mockup|ui|ux)\b/i, 'DESIGN'],
  [/\b(test|qa|test[-_ ]?plan|test[-_ ]?report)\b/i, 'TEST'],
  [/\b(deploy|release|rollout|runbook)\b/i, 'DEPLOY'],
  [/\b(maintain|maintenance|incident|postmortem|monitoring)\b/i, 'MAINTAIN'],
  [/\b(build|implementation|code)\b/i, 'BUILD'],
];

const DESIGN_NAME: [RegExp, DesignFolder][] = [
  [/\b(hld|high[-_ ]?level)\b/i, 'hld'],
  [/\b(lld|low[-_ ]?level)\b/i, 'lld'],
  [/\b(ui|ux|wireframe|mockup|screens?)\b/i, 'ui'],
  [/\b(architecture|arch|diagram)\b/i, 'architecture'],
];

/** Name without its extension, with _ and - as word breaks so `\b` matches "auth_hld.md". */
const words = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');

export function stageOf(a: Pick<Artifact, 'stage' | 'kind' | 'name'>): SdlcStage {
  if (a.stage) return a.stage;
  const byKind = KIND_STAGE[a.kind];
  if (byKind) return byKind;
  const name = words(a.name);
  return NAME_STAGE.find(([re]) => re.test(name))?.[1] ?? 'PLAN';
}

/** The Design sub-folder a file belongs in, or null to sit directly in Design. */
export function designFolderOf(a: Pick<Artifact, 'kind' | 'name'>): DesignFolder | null {
  const name = words(a.name);
  const hit = DESIGN_NAME.find(([re]) => re.test(name))?.[1];
  if (hit) return hit;
  return a.kind === 'diagram' ? 'architecture' : null;
}

export interface StageFolder {
  stage: SdlcStage;
  label: string;
  /** Files directly in the folder (for Design: those matching no sub-folder). */
  files: Artifact[];
  /** Design only: its sub-folders, in order. */
  subfolders: { key: DesignFolder; label: string; files: Artifact[] }[];
  count: number;
}

/** Every stage folder in loop order (empty ones included), each keeping the list's order. */
export function groupByStage(items: Artifact[]): StageFolder[] {
  return SDLC_STAGES.map((stage) => {
    const inStage = items.filter((a) => stageOf(a) === stage);
    if (stage !== 'DESIGN') {
      return {
        stage,
        label: STAGE_FOLDER_LABEL[stage],
        files: inStage,
        subfolders: [],
        count: inStage.length,
      };
    }
    return {
      stage,
      label: STAGE_FOLDER_LABEL[stage],
      files: inStage.filter((a) => designFolderOf(a) === null),
      subfolders: DESIGN_FOLDERS.map((f) => ({
        ...f,
        files: inStage.filter((a) => designFolderOf(a) === f.key),
      })),
      count: inStage.length,
    };
  });
}
