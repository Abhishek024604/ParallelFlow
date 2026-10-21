import { CMP_ID, type GateId, isPhaseId } from './layout.js';
import { contentHash, setFrontmatterFields } from './markdown.js';
import { gateOf, parseGate, snapshot } from './state.js';
import { governanceCheck, governanceClean, renderGovernance } from './governance.js';
import type { SwaResources } from './resources.js';
import type { ArchStore } from './store.js';
import { renderProblems, validate } from './validate.js';

// The architect's actions (the /swa command; never a tool the model can call). On the files host
// they write arch/.swa/state.json; on the arena host a person approves in the app instead.

const BEFORE: Partial<Record<GateId, GateId>> = { G1: 'G0', G2: 'G1', G3: 'G2' };

export type ActionResult =
  { ok: true; message: string; baseline?: boolean } | { ok: false; message: string };

/**
 * Why a gate's files can't be approved yet (empty = they can): validation problems, and for G1 a
 * stack that breaks the governance rules.
 */
export async function gateProblems(
  store: ArchStore,
  gate: GateId,
  paths: readonly string[],
  resources?: SwaResources,
): Promise<string[]> {
  const out: string[] = [];
  const problems = await validate(store, paths);
  if (problems.length) out.push(renderProblems(problems));
  if (gate === 'G1' && resources) {
    const report = await governanceCheck(store, resources);
    if (!governanceClean(report)) out.push(renderGovernance(report));
  }
  return out;
}

export async function approveGate(
  store: ArchStore,
  raw: string,
  by: string,
  resources?: SwaResources,
): Promise<ActionResult> {
  const target = parseGate(raw);
  if (!target) {
    return {
      ok: false,
      message: 'Name a gate: /swa approve G0, G1, G2, or G3:CMP-003 for one component.',
    };
  }
  if (!store.approve) return { ok: false, message: 'Approve these files in the app.' };
  const snap = await snapshot(store);
  const gate = gateOf(snap, target.gate, target.component);
  const key = target.component ? `G3:${target.component}` : target.gate;
  if (!gate || gate.state === 'empty') return { ok: false, message: `${key} has no files yet.` };
  if (gate.state === 'approved') return { ok: true, message: `${key} is already approved.` };
  if (gate.missing.length) {
    return {
      ok: false,
      message: `${key} can't be approved yet: arch/${gate.missing.join(', arch/')} ${gate.missing.length > 1 ? 'are' : 'is'} missing.`,
    };
  }
  const before = BEFORE[target.gate];
  if (before && gateOf(snap, before)?.state !== 'approved') {
    return { ok: false, message: `Approve ${before} first: ${key} builds on it.` };
  }
  const blocking = await gateProblems(
    store,
    target.gate,
    gate.files.map((f) => f.path),
    resources,
  );
  if (blocking.length) {
    return { ok: false, message: `${key} can't be approved yet:\n${blocking.join('\n')}` };
  }
  const entries: { path: string; hash: string }[] = [];
  for (const file of gate.files) {
    if (file.state === 'approved') continue;
    let text = (await store.read(file.path)) ?? '';
    if (file.path.endsWith('.md')) {
      const marked = setFrontmatterFields(text, { status: 'approved' });
      if (marked !== text) {
        await store.write(file.path, marked);
        text = marked;
      }
    }
    entries.push({ path: file.path, hash: contentHash(text) });
  }
  await store.approve(entries, key, by);
  const baseline = target.gate === 'G2';
  if (baseline) await store.addBaseline?.({ gate: 'G2', at: new Date().toISOString() });
  return {
    ok: true,
    baseline,
    message: `${key} approved: ${entries.map((e) => e.path).join(', ')}.${baseline ? ' This is the architecture baseline.' : ''}`,
  };
}

export async function overridePhase(
  store: ArchStore,
  raw: string,
  by: string,
): Promise<ActionResult> {
  const [phase = '', component] = raw.trim().split(/\s+/);
  if (!isPhaseId(phase)) {
    return {
      ok: false,
      message:
        'Name a phase: /swa override stack (or hld, review-design, lld CMP-003, review-code).',
    };
  }
  if (phase === 'lld' && !(component && CMP_ID.test(component.toUpperCase()))) {
    return { ok: false, message: 'Name the component: /swa override lld CMP-003.' };
  }
  if (!store.addOverride) return { ok: false, message: 'Overrides are made in the app.' };
  await store.addOverride({
    phase,
    ...(phase === 'lld' && component && { component: component.toUpperCase() }),
    by,
    at: new Date().toISOString(),
  });
  return {
    ok: true,
    message: `${phase}${phase === 'lld' ? ` ${component?.toUpperCase()}` : ''} may start before its gates are approved.`,
  };
}
