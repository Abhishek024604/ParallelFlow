import { isStandardFileName } from './file-names.js';

// SWA's arch/ files as documents (arena or private chat). SWA keeps its own layout (arch/hld/hld.md,
// arch/lld/CMP-001/lld.md, …); each path is saved under a standard file name (file-names.ts), so an
// arena holds only standard names and SWA reads the team's files where they match:
//
//   inputs/srs.md ↔ requirements.md          hld/hld.md ↔ hld.md
//   inputs/goal.md ↔ plan-goal.md            hld/flows/checkout.drawio ↔ hld-flow-checkout.drawio
//   stack.md ↔ architecture-stack.md         lld/CMP-001/lld.md ↔ lld-CMP-001.md
//   model.yaml ↔ architecture-model.yaml     lld/CMP-001/openapi.yaml ↔ lld-CMP-001--openapi.yaml
//
// The mapping is exact both ways: archDocName checks that its name maps back to the same path and
// otherwise uses the generic form architecture-arch--<path, "/" as "--">.md. Names saved before
// the rule ("arch › hld › hld.md") are still read.

export const ARCH_SEPARATOR = ' › ';
const LEGACY_PREFIX = `arch${ARCH_SEPARATOR}`;

/** SWA's own state, kept as a document but not shown in the file tree. */
export const ARCH_STATE_NAME = 'architecture-swa-state.json';

const FIXED: [path: string, name: string][] = [
  ['inputs/srs.md', 'requirements.md'],
  ['inputs/goal.md', 'plan-goal.md'],
  ['inputs/meeting-summary.md', 'plan-meeting-summary.md'],
  ['inputs/governance.yaml', 'architecture-governance.yaml'],
  ['00-drivers.md', 'architecture-drivers.md'],
  ['stack.md', 'architecture-stack.md'],
  ['model.yaml', 'architecture-model.yaml'],
  ['risks.md', 'architecture-risks.md'],
  ['reviews/hld-review.md', 'hld-review.md'],
  ['.swa/state.json', ARCH_STATE_NAME],
  ['hld/hld.md', 'hld.md'],
];
const BY_PATH = new Map(FIXED);
const BY_NAME = new Map(FIXED.map(([p, n]) => [n, p]));

const enc = (path: string) => path.split('/').join('--');
const dec = (part: string) => part.split('--').join('/');

/** [path pattern → name, name pattern → path] pairs, most specific first. */
const RULES: [RegExp, (m: RegExpExecArray) => string, RegExp, (m: RegExpExecArray) => string][] = [
  [
    /^hld\/flows\/([^/]+)$/,
    (m) => `hld-flow-${m[1]}`,
    /^hld-flow-(.+)$/,
    (m) => `hld/flows/${m[1]}`,
  ],
  [
    /^hld\/sketches\/([^/]+)$/,
    (m) => `hld-sketch-${m[1]}`,
    /^hld-sketch-(.+)$/,
    (m) => `hld/sketches/${m[1]}`,
  ],
  [
    /^lld\/(CMP-\d{1,4})\/lld\.md$/,
    (m) => `lld-${m[1]}.md`,
    /^lld-(CMP-\d{1,4})\.md$/,
    (m) => `lld/${m[1]}/lld.md`,
  ],
  [
    /^lld\/(CMP-\d{1,4})\/(.+)$/,
    (m) => `lld-${m[1]}--${enc(m[2] ?? '')}`,
    /^lld-(CMP-\d{1,4})--(.+)$/,
    (m) => `lld/${m[1]}/${dec(m[2] ?? '')}`,
  ],
  [
    /^decisions\/(ADR-\d{4}-[a-z0-9-]+\.md)$/,
    (m) => `architecture-${m[1]}`,
    /^architecture-(ADR-\d{4}-[a-z0-9-]+\.md)$/,
    (m) => `decisions/${m[1]}`,
  ],
  [
    /^reviews\/code-([\w-]+\.md)$/,
    (m) => `build-review-${m[1]}`,
    /^build-review-([\w-]+\.md)$/,
    (m) => `reviews/code-${m[1]}`,
  ],
  [
    /^reviews\/impact-([\w-]+\.md)$/,
    (m) => `maintain-impact-${m[1]}`,
    /^maintain-impact-([\w-]+\.md)$/,
    (m) => `reviews/impact-${m[1]}`,
  ],
  [
    /^fitness\/(.+)$/,
    (m) => `test-fitness--${enc(m[1] ?? '')}`,
    /^test-fitness--(.+)$/,
    (m) => `fitness/${dec(m[1] ?? '')}`,
  ],
  [/^hld\/([^/]+)$/, (m) => `hld-${m[1]}`, /^hld-(.+)$/, (m) => `hld/${m[1]}`],
];
const GENERIC = /^architecture-arch--(.+)\.md$/;

const relOf = (path: string) => path.replace(/^arch\//, '');

/** The arch/ path (relative to arch/) of a document name, or null when it is not an arch/ file. */
export function archPathOf(name: string): string | null {
  if (name.startsWith(LEGACY_PREFIX)) {
    const rel = name.slice(LEGACY_PREFIX.length).split(ARCH_SEPARATOR).join('/');
    return rel ? rel : null;
  }
  const fixed = BY_NAME.get(name);
  if (fixed) return fixed;
  const generic = GENERIC.exec(name);
  if (generic) return dec(generic[1] ?? '');
  for (const [, , nameRe, toPath] of RULES) {
    const m = nameRe.exec(name);
    if (m) return toPath(m);
  }
  return null;
}

/** The standard document name for an arch/ path ("hld/hld.md" or "arch/hld/hld.md"). */
export function archDocName(path: string): string {
  const rel = relOf(path);
  const fixed = BY_PATH.get(rel);
  if (fixed) return fixed;
  for (const [pathRe, toName] of RULES) {
    const m = pathRe.exec(rel);
    if (!m) continue;
    const name = toName(m);
    // Only when the name is standard and reads back as the same path.
    if (isStandardFileName(name) && archPathOf(name) === rel) return name;
    break;
  }
  return `architecture-arch--${enc(rel)}.md`;
}

export const isArchDocName = (name: string): boolean => archPathOf(name) !== null;
