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
// its standard name when it is pushed to an arena (arenaNameForPush).
//
// A name may sit in up to three folders inside its stage folder, written with " › " like private
// folders: "Backlog › requirements-story-001.md", "HLD › Flows › hld-checkout.drawio". The last
// part (the leaf) is still a standard name, and it decides the stage.

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

/** Between the folders of a name and its leaf (the same as private folders). */
export const FOLDER_SEPARATOR = ' › ';
/** Folders inside a stage folder, at most. */
export const MAX_FOLDER_DEPTH = 3;
export const FOLDER_SEGMENT_MAX_CHARS = 32;
/** Letters, digits, space . _ -; starts with a letter or digit, does not end in a space or ".". */
const FOLDER_SEGMENT = new RegExp(
  `^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,${FOLDER_SEGMENT_MAX_CHARS - 2}}[A-Za-z0-9_-])?$`,
);

export interface ParsedFileName {
  base: FileBase;
  suffix: string | null;
  ext: string;
  stage: SdlcStage;
  /** Folders inside the stage folder, outermost first; [] for a file at the top of its stage. */
  folders: string[];
  /** The standard name without its folders. */
  leaf: string;
}

/** "Backlog › requirements-x.md" → folders ["Backlog"], leaf "requirements-x.md" (not checked). */
export function splitArenaName(name: string): { folders: string[]; leaf: string } {
  const parts = name.split(FOLDER_SEPARATOR);
  const leaf = parts.pop() ?? name;
  return { folders: parts, leaf };
}

/** Whether `segment` may be one folder of an arena name. */
export const isFolderSegment = (segment: string): boolean => FOLDER_SEGMENT.test(segment);

/** The parts of a standard name, or null when the name is not standard. */
export function parseFileName(name: string): ParsedFileName | null {
  const { folders, leaf } = splitArenaName(name);
  if (folders.length > MAX_FOLDER_DEPTH || !folders.every(isFolderSegment)) return null;
  // Names saved before the rule ("arch › hld › hld.md", "pm › …") are private layouts, not folders.
  if (folders[0] === 'arch' || folders[0] === 'pm') return null;
  const m = STANDARD.exec(leaf);
  if (!m) return null;
  const base = m[1] as FileBase;
  // A suffix must not end in "." (it would read as a second extension).
  if (m[2]?.endsWith('.')) return null;
  return {
    base,
    suffix: m[2] ?? null,
    ext: m[3] ?? 'md',
    stage: BASE_STAGE[base],
    folders,
    leaf,
  };
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
  'requirements.md, hld.md, lld-auth.md, architecture-stack.md, test-e2e.md. It may sit in up to three folders, ' +
  'written with " › ": "Backlog › requirements-story-001.md". Saving an existing name adds a version.';

const KEYWORDS: [RegExp, FileBase][] = [
  [/\b(hld|high[-_ ]?level)\b/i, 'hld'],
  [/\b(lld|low[-_ ]?level)\b/i, 'lld'],
  [/\b(architecture|arch|diagram|adr|stack)\b/i, 'architecture'],
  [
    /\b(requirements?|prd|srs|brief|spec|specification|user[-_ ]?stor(y|ies)|stor(y|ies)|epics?|backlog)\b/i,
    'requirements',
  ],
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

const words = (text: string) => text.replace(/\.[A-Za-z0-9]+$/, '').replace(/[_.]+/g, ' ');

/** The base a free-form name's words point to, or null. */
const baseFromWords = (text: string): FileBase | null =>
  KEYWORDS.find(([re]) => re.test(words(text)))?.[1] ?? null;

/**
 * The standard name to suggest for any name (a private file being pushed, an old arena file):
 * the name itself when it is already standard, otherwise the base its words point to (falling
 * back to the stage's default), without a suffix. Callers add a suffix to keep names unique.
 */
export function suggestFileName(name: string, stage: SdlcStage = 'PLAN'): string {
  const trimmed = name.trim();
  if (isStandardFileName(trimmed)) return trimmed;
  const base = baseFromWords(trimmed) ?? STAGE_BASE[stage];
  return `${base}.${extOf(trimmed)}`;
}

/** `name` made unique among `taken` with a numeric suffix: hld.md → hld-2.md → hld-3.md. */
export function uniqueFileName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const { folders, leaf } = splitArenaName(name);
  const prefix = folders.map((f) => `${f}${FOLDER_SEPARATOR}`).join('');
  const parsed = parseFileName(name);
  const base = parsed
    ? `${parsed.base}${parsed.suffix ? `-${parsed.suffix}` : ''}`
    : leaf.replace(/\.[^.]+$/, '');
  const ext = parsed?.ext ?? extOf(leaf);
  for (let n = 2; ; n++) {
    const candidate = `${prefix}${base}-${n}.${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------- pushing private files

/** Private folder roots that an arena already shows another way (its stage folders). */
const PRIVATE_ROOTS = new Set(['pm', 'arch', 'architecture']);
const SUFFIX_MAX_CHARS = 40;
/** The artifact name limit (files.ts ARTIFACT_NAME_MAX_CHARS), and the folders' share of it. */
const NAME_MAX_CHARS = 120;
const PREFIX_MAX_CHARS = 50;

/** One private folder name as an arena folder: "backlog" → "Backlog", unsafe characters as "-". */
export function arenaFolderSegment(name: string): string | null {
  const clean = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-{2,}/g, '-')
    .slice(0, FOLDER_SEGMENT_MAX_CHARS)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[\s.-]+$/, '');
  if (!clean) return null;
  const titled = clean.charAt(0).toUpperCase() + clean.slice(1);
  return isFolderSegment(titled) ? titled : null;
}

/**
 * The arena folders for a private folder path: the private roots "pm" and "Architecture" are
 * dropped (the stage folders already say it), the rest kept, at most three deep.
 * ["pm", "backlog"] → ["Backlog"]; ["Architecture", "HLD", "Flows"] → ["HLD", "Flows"].
 */
export function arenaFoldersFor(privateFolders: readonly string[]): string[] {
  const parts = privateFolders.map((p) => p.trim()).filter(Boolean);
  if (parts[0] && PRIVATE_ROOTS.has(parts[0].toLowerCase())) parts.shift();
  return parts
    .map(arenaFolderSegment)
    .filter((p): p is string => p !== null)
    .slice(0, MAX_FOLDER_DEPTH);
}

/** A suffix from a private file's name: "STORY-001.md" → "story-001" (null when none is left). */
export function suffixFrom(leaf: string, base: FileBase): string | null {
  let slug = leaf
    .replace(/\.[A-Za-z0-9]+$/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // "Requirements v2" under requirements → "v2", not "requirements-v2".
  if (slug === base) return null;
  if (slug.startsWith(`${base}-`)) slug = slug.slice(base.length + 1);
  slug = slug.slice(0, SUFFIX_MAX_CHARS).replace(/[-.]+$/, '');
  return slug && /^[a-z0-9]/.test(slug) ? slug : null;
}

/**
 * The arena name for a private file being pushed (ADR-038), unique among `taken`:
 *   - a private name whose leaf is already standard ("hld.md", "checkout › lld-auth.md") keeps
 *     that leaf, even when taken (it adds a version to that file);
 *   - otherwise the base its words (then its folders' words) point to, else the stage's default,
 *     with a suffix from its own name when the bare base is taken, or always (`alwaysSuffix`, a
 *     folder push): STORY-001.md → requirements-story-001.md; made unique among `taken`;
 *   - inside the arena folders of its private folders (arenaFoldersFor): "pm › backlog › …" →
 *     "Backlog › …". `folders` gives the private folders when the name does not carry them.
 */
export function arenaNameForPush(
  privateName: string,
  input: {
    stage?: SdlcStage;
    taken?: ReadonlySet<string>;
    alwaysSuffix?: boolean;
    folders?: readonly string[];
  } = {},
): string {
  const own = splitArenaName(privateName.trim());
  const leaf = own.leaf.trim();
  const privateFolders = input.folders ?? own.folders;
  const folders = arenaFoldersFor(privateFolders);
  // Names stay within the artifact name limit: the deepest folders go first.
  const room = isStandardFileName(leaf) ? NAME_MAX_CHARS - leaf.length : PREFIX_MAX_CHARS;
  while (folders.length > 0 && folders.join(FOLDER_SEPARATOR).length + 3 > room) folders.pop();
  const prefix = folders.map((f) => `${f}${FOLDER_SEPARATOR}`).join('');
  const taken = input.taken ?? new Set<string>();
  if (isSystemFileName(leaf)) return leaf;
  if (isStandardFileName(leaf)) return `${prefix}${leaf}`;

  const base =
    baseFromWords(leaf) ??
    baseFromWords(privateFolders.join(' ')) ??
    STAGE_BASE[input.stage ?? 'PLAN'];
  const ext = extOf(leaf);
  const bare = `${prefix}${base}.${ext}`;
  const suffix = suffixFrom(leaf, base);
  if (!suffix || (!input.alwaysSuffix && !taken.has(bare))) return uniqueFileName(bare, taken);
  return uniqueFileName(`${prefix}${base}-${suffix}.${ext}`, taken);
}
