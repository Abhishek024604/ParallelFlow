import type { SdlcStage } from './arenas.js';

// Arena file names (doc 02 F14): every file in an arena has a standard name, so a team finds the
// same document under the same name in every arena. A name is a base for the kind of document,
// optionally a suffix, then an extension:
//
//   plan.md · requirements.md · hld.md · lld-auth.md · architecture-stack.md · test-e2e.md …
//
// The base files the document under its SDLC stage folder (plan → Plan, hld → Design, …). Saving
// a name that already exists in the arena adds a version to that file. The arena's own files
// README.md, PROGRESS.md and STATE.md keep their names. Private files are free-form: a file gets
// its standard name when it is pushed to an arena (suggestFileName).

export const FILE_BASES = [
  'plan',
  'requirements',
  'hld',
  'lld',
  'architecture',
  'build',
  'test',
  'deploy',
  'maintain',
] as const;
export type FileBase = (typeof FILE_BASES)[number];

export const BASE_STAGE: Record<FileBase, SdlcStage> = {
  plan: 'PLAN',
  requirements: 'PLAN',
  hld: 'DESIGN',
  lld: 'DESIGN',
  architecture: 'DESIGN',
  build: 'BUILD',
  test: 'TEST',
  deploy: 'DEPLOY',
  maintain: 'MAINTAIN',
};

/** The base name each stage suggests first (a stage's default document). */
export const STAGE_BASE: Record<SdlcStage, FileBase> = {
  PLAN: 'plan',
  DESIGN: 'hld',
  BUILD: 'build',
  TEST: 'test',
  DEPLOY: 'deploy',
  MAINTAIN: 'maintain',
};

/** The arena's own files, which keep their exact names. */
export const ARENA_SYSTEM_FILES = ['README.md', 'PROGRESS.md', 'STATE.md'] as const;

export const FILE_EXTENSIONS = ['md', 'yaml', 'yml', 'json', 'drawio', 'excalidraw'] as const;

const SUFFIX = '[A-Za-z0-9][A-Za-z0-9._-]{0,79}';
const STANDARD = new RegExp(
  `^(${FILE_BASES.join('|')})(?:-(${SUFFIX}))?\\.(${FILE_EXTENSIONS.join('|')})$`,
);

export interface ParsedFileName {
  base: FileBase;
  suffix: string | null;
  ext: string;
  stage: SdlcStage;
}

/** The parts of a standard name, or null when the name is not standard. */
export function parseFileName(name: string): ParsedFileName | null {
  const m = STANDARD.exec(name);
  if (!m) return null;
  const base = m[1] as FileBase;
  // A suffix must not end in "." (it would read as a second extension).
  if (m[2]?.endsWith('.')) return null;
  return { base, suffix: m[2] ?? null, ext: m[3] ?? 'md', stage: BASE_STAGE[base] };
}

export const isSystemFileName = (name: string): boolean =>
  (ARENA_SYSTEM_FILES as readonly string[]).includes(name);

/** Whether an arena may hold a file with this name. */
export const isStandardFileName = (name: string): boolean =>
  isSystemFileName(name) || parseFileName(name) !== null;

/** The stage folder a standard name files under; null for the arena's own files and others. */
export const stageOfFileName = (name: string): SdlcStage | null =>
  parseFileName(name)?.stage ?? null;

/** The rule, in one sentence, for error messages and the AI's instructions. */
export const FILE_NAME_RULE =
  'Arena files use a standard name: plan, requirements, hld, lld, architecture, build, test, deploy or maintain, ' +
  'optionally followed by "-" and a short suffix, then .md (or .yaml, .json, .drawio): for example plan.md, ' +
  'requirements.md, hld.md, lld-auth.md, architecture-stack.md, test-e2e.md. Saving an existing name adds a version.';

const KEYWORDS: [RegExp, FileBase][] = [
  [/\b(hld|high[-_ ]?level)\b/i, 'hld'],
  [/\b(lld|low[-_ ]?level)\b/i, 'lld'],
  [/\b(architecture|arch|diagram|adr|stack)\b/i, 'architecture'],
  [/\b(requirements?|prd|srs|brief|spec|specification|user[-_ ]?stor(y|ies))\b/i, 'requirements'],
  [/\b(tests?|qa|test[-_ ]?plan|test[-_ ]?report)\b/i, 'test'],
  [/\b(deploy|deployment|release|rollout|runbook)\b/i, 'deploy'],
  [/\b(maintain|maintenance|incident|postmortem|monitoring)\b/i, 'maintain'],
  [/\b(build|implementation|code)\b/i, 'build'],
  [/\b(plan|goal|roadmap|launch|okr)\b/i, 'plan'],
];

const extOf = (name: string): string => {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  const ext = m?.[1]?.toLowerCase() ?? 'md';
  return (FILE_EXTENSIONS as readonly string[]).includes(ext) ? ext : 'md';
};

/**
 * The standard name to suggest for any name (a private file being pushed, an old arena file):
 * the name itself when it is already standard, otherwise the base its words point to (falling
 * back to the stage's default), without a suffix. Callers add a suffix to keep names unique.
 */
export function suggestFileName(name: string, stage: SdlcStage = 'PLAN'): string {
  const trimmed = name.trim();
  if (isStandardFileName(trimmed)) return trimmed;
  const words = trimmed.replace(/\.[A-Za-z0-9]+$/, '').replace(/[_.]+/g, ' ');
  const base = KEYWORDS.find(([re]) => re.test(words))?.[1] ?? STAGE_BASE[stage];
  return `${base}.${extOf(trimmed)}`;
}

/** `name` made unique among `taken` with a numeric suffix: hld.md → hld-2.md → hld-3.md. */
export function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const parsed = parseFileName(name);
  const base = parsed
    ? `${parsed.base}${parsed.suffix ? `-${parsed.suffix}` : ''}`
    : name.replace(/\.[^.]+$/, '');
  const ext = parsed?.ext ?? extOf(name);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}.${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
