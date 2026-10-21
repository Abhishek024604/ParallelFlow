import {
  classifyPath,
  CMP_ID,
  type GateId,
  gateOfPath,
  phase as phaseOf,
  PHASES,
  type PhaseId,
  REQUIRED_INPUTS,
} from './layout.js';
import { contentHash, readFrontmatter } from './markdown.js';
import type { ArchStore, Override } from './store.js';

// Where the project stands: each file's approval, each gate, and whether a phase may start. All of
// it is computed from the files and the approvals, so nothing can drift: editing an approved file
// makes it a draft again (its hash no longer matches), and the gate reopens.

export type FileState = 'approved' | 'changed' | 'stale' | 'draft';

export interface FileStatus {
  path: string;
  state: FileState;
  hash: string;
  gate?: GateId;
  component?: string;
  /** The frontmatter `status`, when the file has one. */
  status?: string;
}

export type GateState = 'approved' | 'open' | 'empty';

export interface GateStatus {
  gate: GateId;
  component?: string;
  /** "G3:CMP-003" for component gates. */
  key: string;
  state: GateState;
  files: FileStatus[];
  /** Files the gate needs that do not exist yet. */
  missing: string[];
}

export interface Snapshot {
  files: FileStatus[];
  inputs: { present: string[]; missing: string[] };
  gates: GateStatus[];
  overrides: Override[];
  /** Where approvals happen: the /swa command (files) or the app. */
  host: ArchStore['kind'];
  /** Who approves in the app. */
  approver: string;
}

const REQUIRED_FILES: Record<'G0' | 'G1' | 'G2', readonly string[]> = {
  G0: ['00-drivers.md'],
  G1: ['stack.md'],
  G2: ['model.yaml', 'hld/hld.md', 'reviews/hld-review.md'],
};

export const gateKey = (gate: GateId, component?: string): string =>
  gate === 'G3' && component ? `G3:${component}` : gate;

/** "G1", "g1", "G3:CMP-003", "G3 CMP-003" → the gate; null when it is not one. */
export function parseGate(raw: string): { gate: GateId; component?: string } | null {
  const m = /^(G[0-3])(?:[:\s]+(CMP-\d{1,4}))?$/i.exec(raw.trim());
  if (!m?.[1]) return null;
  const gate = m[1].toUpperCase() as GateId;
  const component = m[2]?.toUpperCase();
  if (gate === 'G3') return component ? { gate, component } : null;
  if (component) return null;
  return { gate };
}

export async function snapshot(store: ArchStore): Promise<Snapshot> {
  const [paths, approvals, overrides] = await Promise.all([
    store.list(),
    store.approvals(),
    store.overrides(),
  ]);
  const files: FileStatus[] = [];
  for (const path of paths) {
    const kind = classifyPath(path);
    if (kind.kind !== 'artifact') continue;
    const text = (await store.read(path)) ?? '';
    const hash = contentHash(text);
    const fm = path.endsWith('.md') ? readFrontmatter(text).data : {};
    const status = typeof fm['status'] === 'string' ? fm['status'] : undefined;
    const approval = approvals[path];
    const state: FileState =
      approval?.hash === hash
        ? 'approved'
        : status === 'stale'
          ? 'stale'
          : approval
            ? 'changed'
            : 'draft';
    const gate = gateOfPath(path, typeof fm['gate'] === 'string' ? fm['gate'] : undefined);
    files.push({
      path,
      state,
      hash,
      ...(gate && { gate: gate.gate }),
      ...(gate?.component && { component: gate.component }),
      ...(status && { status }),
    });
  }

  const present = paths.filter((p) => p.startsWith('inputs/'));
  const inputs = { present, missing: REQUIRED_INPUTS.filter((p) => !present.includes(p)) };

  const gateStatus = (gate: GateId, component?: string): GateStatus => {
    const own = files.filter(
      (f) => f.gate === gate && (gate !== 'G3' || f.component === component),
    );
    const required =
      gate === 'G3' ? [`lld/${component}/lld.md`] : REQUIRED_FILES[gate as 'G0' | 'G1' | 'G2'];
    const missing = required.filter((p) => !own.some((f) => f.path === p));
    const state: GateState =
      own.length === 0
        ? 'empty'
        : missing.length === 0 && own.every((f) => f.state === 'approved')
          ? 'approved'
          : 'open';
    return {
      gate,
      key: gateKey(gate, component),
      state,
      files: own,
      missing,
      ...(component && { component }),
    };
  };

  const components = [
    ...new Set(
      files.filter((f) => f.gate === 'G3' && f.component).map((f) => f.component as string),
    ),
  ].sort();
  const gates = [
    gateStatus('G0'),
    gateStatus('G1'),
    gateStatus('G2'),
    ...components.map((c) => gateStatus('G3', c)),
  ];
  return {
    files,
    inputs,
    gates,
    overrides,
    host: store.kind,
    approver: store.approver ?? 'the architect',
  };
}

export const gateOf = (snap: Snapshot, gate: GateId, component?: string): GateStatus | undefined =>
  snap.gates.find((g) => g.key === gateKey(gate, component));

const overridden = (snap: Snapshot, phase: PhaseId, component?: string): boolean =>
  snap.overrides.some((o) => o.phase === phase && (!o.component || o.component === component));

/**
 * Whether a phase may start: its inputs exist and the gates before it are approved, or the
 * architect overrode it. The reason is written for the model and the architect alike.
 */
export function canStart(
  snap: Snapshot,
  phase: PhaseId,
  component?: string,
): { ok: true; overridden?: boolean } | { ok: false; reason: string } {
  if (phase === 'lld' && (!component || !CMP_ID.test(component))) {
    return { ok: false, reason: 'LLD runs for one component: give its id, for example CMP-003.' };
  }
  if (snap.inputs.missing.length && phase !== 'impact') {
    return {
      ok: false,
      reason: `The architect has not added ${snap.inputs.missing.map((p) => `arch/${p}`).join(' and ')} yet (the SRS and goal.md are mandatory).`,
    };
  }
  if (phase === 'review-design') {
    const missing = ['model.yaml', 'hld/hld.md'].filter(
      (p) => !snap.files.some((f) => f.path === p),
    );
    if (missing.length) {
      return {
        ok: false,
        reason: `The HLD review needs arch/${missing.join(' and arch/')}: run /swa hld first.`,
      };
    }
  }
  const open = phaseOf(phase).requires.filter((g) => gateOf(snap, g)?.state !== 'approved');
  if (!open.length) return { ok: true };
  if (overridden(snap, phase, component)) return { ok: true, overridden: true };
  const p = phaseOf(phase);
  const first = gateOf(snap, open[0] as GateId);
  const how =
    snap.host === 'app'
      ? `${capital(snap.approver)} approve${snap.approver === 'you' ? '' : 's'} each of its documents in the app (open ${first?.files.map((f) => `arch/${f.path}`).join(', ') || 'the document'} and press Approve).`
      : `The architect approves with "/swa approve ${open[0]}", or lets this phase start anyway with "/swa override ${phase}${component ? ` ${component}` : ''}".`;
  return {
    ok: false,
    reason: `${p.number} · ${p.title} needs gate ${open.join(' and ')} approved first. ${how}`,
  };
}

/** The phase a write to `path` belongs to, for canStart (null: no phase rule). */
export function phaseForWrite(path: string): { phase: PhaseId; component?: string } | null {
  const kind = classifyPath(path);
  if (kind.kind !== 'artifact') return null;
  switch (kind.phase) {
    case 'adr':
    case 'risks':
      // ADRs and the risk register are written from the stack phase on.
      return { phase: 'stack' };
    default:
      return { phase: kind.phase, ...(kind.component && { component: kind.component }) };
  }
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line about what to do next. */
export function nextStep(snap: Snapshot): string {
  const approve = (gate: string) =>
    snap.host === 'app'
      ? `${snap.approver} press${snap.approver === 'you' ? '' : 'es'} Approve on each in the app`
      : `/swa approve ${gate}`;
  if (snap.inputs.missing.length) {
    const missing = snap.inputs.missing.map((p) => `arch/${p}`).join(' and ');
    return snap.host === 'app'
      ? `Add ${missing} as documents here (or ask the AI to copy the SRS and goals into them), then run /swa intake.`
      : `Add ${missing} (templates: arch/inputs/goal.md from /swa init), then run /swa intake.`;
  }
  const g = (key: GateId) => gateOf(snap, key);
  const step = (gate: GateId, run: string): string | null => {
    const s = g(gate);
    if (s?.state === 'approved') return null;
    if (!s || s.state === 'empty') return `Run ${run}.`;
    if (s.missing.length)
      return `${gate} still needs ${s.missing.map((p) => `arch/${p}`).join(', ')}: run ${run}.`;
    return `Review ${s.files
      .filter((f) => f.state !== 'approved')
      .map((f) => `arch/${f.path}`)
      .join(', ')}, then ${approve(gate)}.`;
  };
  if (
    g('G2')?.state !== 'approved' &&
    g('G1')?.state === 'approved' &&
    !snap.files.some((f) => f.path === 'hld/hld.md')
  ) {
    return 'Run /swa hld.';
  }
  if (
    g('G2')?.state !== 'approved' &&
    snap.files.some((f) => f.path === 'hld/hld.md') &&
    !snap.files.some((f) => f.path === 'reviews/hld-review.md')
  ) {
    return 'Run /swa review-design.';
  }
  const open =
    step('G0', '/swa intake') ??
    step('G1', '/swa stack') ??
    step('G2', '/swa hld, then /swa review-design');
  if (open) return open;
  const lld = snap.gates.find((s) => s.gate === 'G3' && s.state !== 'approved');
  if (lld) return `Review the LLD of ${lld.component}, then ${approve(lld.key)}.`;
  return 'The baseline is approved: run /swa lld <CMP-id> for a component, /swa review-code, or /swa impact after a change.';
}

const STATE_WORD: Record<FileState, string> = {
  approved: 'approved',
  changed: 'changed since approval',
  stale: 'stale',
  draft: 'draft',
};

/** The /swa status text (plain, short; the same for the model and the architect). */
export function renderStatus(snap: Snapshot): string {
  const lines: string[] = ['SWA status'];
  lines.push(
    `Inputs: ${snap.inputs.present.length ? snap.inputs.present.map((p) => p.slice('inputs/'.length)).join(', ') : 'none'}${snap.inputs.missing.length ? ` (missing: ${snap.inputs.missing.map((p) => p.slice('inputs/'.length)).join(', ')})` : ''}`,
  );
  for (const gate of snap.gates) {
    const word =
      gate.state === 'approved' ? 'approved' : gate.state === 'empty' ? 'not started' : 'open';
    const files = gate.files.map((f) => `${f.path} (${STATE_WORD[f.state]})`).join(', ');
    const missing = gate.missing.length ? `; missing ${gate.missing.join(', ')}` : '';
    lines.push(
      `${gate.key}: ${word}${files ? ` · ${files}` : ''}${gate.state === 'empty' ? '' : missing}`,
    );
  }
  const loose = snap.files.filter((f) => !f.gate);
  if (loose.length)
    lines.push(`Other: ${loose.map((f) => `${f.path} (${STATE_WORD[f.state]})`).join(', ')}`);
  if (snap.overrides.length) {
    lines.push(
      `Overrides: ${snap.overrides.map((o) => `${o.phase}${o.component ? ` ${o.component}` : ''}`).join(', ')}`,
    );
  }
  lines.push(`Next: ${nextStep(snap)}`);
  return lines.join('\n');
}

export const PHASE_LIST = PHASES.map((p) => p.id);
