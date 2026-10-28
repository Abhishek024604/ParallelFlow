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

/**
 * What a phase should know before it runs. Nothing blocks a phase: SWA is a capability. Missing
 * inputs mean the phase works from the conversation (and may copy what the architect said into
 * arch/inputs/); an approval is the architect's record, not a lock. `notes` are one-line facts for
 * the model and the architect; `unapproved` lists the earlier gates not approved yet.
 */
export function canStart(
  snap: Snapshot,
  phase: PhaseId,
  component?: string,
): { ok: true; unapproved?: GateId[]; notes?: string[] } {
  const notes: string[] = [];
  if (phase === 'lld' && (!component || !CMP_ID.test(component))) {
    notes.push(
      'No component id given: pick the component from model.yaml or the HLD and say which.',
    );
  }
  if (snap.inputs.missing.length && phase !== 'impact') {
    notes.push(
      `No ${snap.inputs.missing.map((p) => `arch/${p}`).join(' or ')}: work from this conversation and its documents, and save what the architect said as those inputs.`,
    );
  }
  if (phase === 'review-design') {
    const missing = ['model.yaml', 'hld/hld.md'].filter(
      (p) => !snap.files.some((f) => f.path === p),
    );
    if (missing.length) notes.push(`No arch/${missing.join(' or arch/')} yet: review what exists.`);
  }
  const open = phaseOf(phase).requires.filter((g) => gateOf(snap, g)?.state !== 'approved');
  return {
    ok: true,
    ...(open.length && { unapproved: open }),
    ...(notes.length && { notes }),
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

/**
 * One line about what to do next: the next phase whose files do not exist yet. Approvals never hold
 * a phase back; a gate with unapproved files gets an optional reminder.
 */
export function nextStep(snap: Snapshot): string {
  const has = (path: string) => snap.files.some((f) => f.path === path);
  const run = !has('00-drivers.md')
    ? snap.inputs.missing.length
      ? 'Run /swa intake (or ask for any phase): it works from this conversation and saves the requirements and goals as arch/inputs/.'
      : 'Run /swa intake.'
    : !has('stack.md')
      ? 'Run /swa stack.'
      : !has('hld/hld.md') || !has('model.yaml')
        ? 'Run /swa hld.'
        : !has('reviews/hld-review.md')
          ? 'Run /swa review-design.'
          : 'Run /swa lld <CMP-id> for a component, /swa review-code, or /swa impact after a change.';
  const open = snap.gates.filter((g) => g.state === 'open').map((g) => g.key);
  if (!open.length) return run;
  const how = snap.host === 'app' ? 'press Approve on its documents' : '/swa approve <gate>';
  return `${run} Optional: approve ${open.join(', ')} when you are happy with it (${how}).`;
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
    `Inputs: ${snap.inputs.present.length ? snap.inputs.present.map((p) => p.slice('inputs/'.length)).join(', ') : 'none yet'}${snap.inputs.missing.length ? ` (not added: ${snap.inputs.missing.map((p) => p.slice('inputs/'.length)).join(', ')}; the conversation stands in for them)` : ''}`,
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
