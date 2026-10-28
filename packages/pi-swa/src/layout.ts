// The SWA flow (docs/15_SWA_Extension.md): seven phases, four gates, and the arch/ layout. Paths
// here are relative to arch/ and use forward slashes.

export type PhaseId =
  'intake' | 'stack' | 'hld' | 'review-design' | 'lld' | 'review-code' | 'impact';

export type GateId = 'G0' | 'G1' | 'G2' | 'G3';

export interface Phase {
  id: PhaseId;
  number: number;
  title: string;
  /** The gate this phase ends at (G3 is one gate per component). */
  gate?: GateId;
  /** Gates before this phase: shown as a note when not approved (approvals never block). */
  requires: readonly GateId[];
}

export const PHASES: readonly Phase[] = [
  { id: 'intake', number: 0, title: 'Intake', gate: 'G0', requires: [] },
  { id: 'stack', number: 1, title: 'Stack', gate: 'G1', requires: ['G0'] },
  { id: 'hld', number: 2, title: 'HLD', requires: ['G1'] },
  { id: 'review-design', number: 3, title: 'HLD review', gate: 'G2', requires: ['G1'] },
  { id: 'lld', number: 4, title: 'LLD', gate: 'G3', requires: ['G2'] },
  { id: 'review-code', number: 5, title: 'Code review', requires: ['G2'] },
  { id: 'impact', number: 6, title: 'Change impact', requires: [] },
];

export const phase = (id: PhaseId): Phase => PHASES.find((p) => p.id === id) as Phase;

export const isPhaseId = (value: string): value is PhaseId => PHASES.some((p) => p.id === value);

/** The mandatory inputs (intake reads them; nothing starts without them). */
export const REQUIRED_INPUTS = ['inputs/srs.md', 'inputs/goal.md'] as const;
export const OPTIONAL_INPUTS = ['inputs/meeting-summary.md', 'inputs/governance.yaml'] as const;

export const STATE_FILE = '.swa/state.json';

/** A component id: CMP-001, CMP-12. */
export const CMP_ID = /^CMP-\d{1,4}$/;

export const ARTIFACT_STATUSES = ['draft', 'in-review', 'approved', 'stale', 'superseded'] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** What a path in arch/ is: who writes it, and which phase it belongs to. */
export type PathKind =
  | { kind: 'input' }
  | { kind: 'state' }
  | { kind: 'artifact'; phase: PhaseId | 'adr' | 'risks'; component?: string }
  | { kind: 'unknown' };

/**
 * Normalizes a path given by the model or a person: forward slashes, no leading "arch/" or "./".
 * Returns null for anything that could leave arch/ (absolute, "..", empty segments, control chars).
 */
export function normalizeArchPath(raw: string): string | null {
  let p = raw.trim().replace(/\\/g, '/');
  if (!p || /\p{Cc}/u.test(p) || p.startsWith('/') || /^[a-z]:/i.test(p)) return null;
  p = p.replace(/^(\.\/)+/, '');
  if (p.startsWith('arch/')) p = p.slice('arch/'.length);
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  if (p.length > 200) return null;
  return p;
}

export function classifyPath(path: string): PathKind {
  if (path.startsWith('inputs/')) return { kind: 'input' };
  if (path.startsWith('.swa/')) return { kind: 'state' };
  if (path === '00-drivers.md') return { kind: 'artifact', phase: 'intake' };
  if (path === 'stack.md') return { kind: 'artifact', phase: 'stack' };
  if (/^decisions\/ADR-\d{4}-[a-z0-9-]+\.md$/.test(path)) return { kind: 'artifact', phase: 'adr' };
  if (path === 'model.yaml' || /^hld\/[\w./-]+$/.test(path))
    return { kind: 'artifact', phase: 'hld' };
  if (path === 'reviews/hld-review.md') return { kind: 'artifact', phase: 'review-design' };
  if (path === 'risks.md') return { kind: 'artifact', phase: 'risks' };
  const lld = /^lld\/(CMP-\d{1,4})\/[\w./-]+$/.exec(path);
  if (lld) return { kind: 'artifact', phase: 'lld', component: lld[1] };
  if (/^reviews\/code-[\w-]+\.md$/.test(path) || /^fitness\/[\w./-]+$/.test(path)) {
    return { kind: 'artifact', phase: 'review-code' };
  }
  if (/^reviews\/impact-[\w-]+\.md$/.test(path)) return { kind: 'artifact', phase: 'impact' };
  return { kind: 'unknown' };
}

/** The layout, for error messages and the system prompt. */
export const LAYOUT = `arch/
  inputs/            srs.md, goal.md, meeting-summary.md, governance.yaml (architect-owned)
  00-drivers.md      requirement IDs + quality scenarios
  stack.md
  model.yaml         component model (source of truth for diagrams)
  decisions/         ADR-0001-architecture-style.md, ...
  hld/               hld.md, context.drawio, containers.drawio, flows/*.drawio
  lld/CMP-003/       lld.md, component.drawio, sequence-*.drawio, openapi.yaml
  reviews/           hld-review.md, code-<date>.md, impact-<date>.md
  fitness/           fitness-function tests (for CI later)
  risks.md           risk register + tech debt`;

/**
 * The gate a file counts towards (ADRs: their frontmatter `gate`, default G1). risks.md is a living
 * register fed by every review, and reports are not gated, so they belong to none.
 */
export function gateOfPath(
  path: string,
  adrGate?: string,
): { gate: GateId; component?: string } | null {
  const kind = classifyPath(path);
  if (kind.kind !== 'artifact') return null;
  switch (kind.phase) {
    case 'intake':
      return { gate: 'G0' };
    case 'stack':
      return { gate: 'G1' };
    case 'adr': {
      const g3 = /^G3:(CMP-\d{1,4})$/.exec(adrGate ?? '');
      if (g3) return { gate: 'G3', component: g3[1] };
      return adrGate === 'G2' ? { gate: 'G2' } : { gate: 'G1' };
    }
    case 'hld':
    case 'review-design':
      return { gate: 'G2' };
    case 'lld':
      return { gate: 'G3', ...(kind.component && { component: kind.component }) };
    default:
      return null;
  }
}
