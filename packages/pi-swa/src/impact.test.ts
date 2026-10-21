import { describe, expect, it } from 'vitest';
import { approveGate } from './approve.js';
import { impact, markStale, renderImpact } from './impact.js';
import { inputHash } from './markdown.js';
import { snapshot } from './state.js';
import { MemoryArchStore } from './store.js';
import { planWrite } from './writes.js';

const doc = (id: string, inputs: string[], body = 'Text.') =>
  `---\nid: ${id}\nstatus: draft\nversion: 1\nowner: architect\ninputs: [${inputs.join(', ')}]\n---\n\n# ${id}\n\n${body}\n`;

async function write(store: MemoryArchStore, path: string, content: string) {
  const plan = await planWrite(store, await snapshot(store), { path, content });
  if (!plan.ok) throw new Error(plan.error);
  await store.write(plan.path, plan.text);
}

/** Drivers built from the SRS, approved; the stack built from the drivers. */
async function project() {
  const store = new MemoryArchStore({ 'inputs/srs.md': '# SRS v1', 'inputs/goal.md': '# Goals' });
  await write(store, '00-drivers.md', doc('DRIVERS', ['inputs/srs.md', 'inputs/goal.md']));
  expect((await approveGate(store, 'G0', 'A')).ok).toBe(true);
  await write(store, 'stack.md', doc('STACK', ['00-drivers.md']));
  await write(store, 'decisions/ADR-0001-style.md', doc('ADR-0001', ['00-drivers.md']));
  return store;
}

describe('change impact', () => {
  it('ignores status changes: approving a file is not a change to what was built from it', async () => {
    const store = await project();
    expect(inputHash('---\nid: A\nstatus: draft\n---\nx')).toBe(
      inputHash('---\nid: A\nstatus: approved\n---\nx'),
    );
    expect((await impact(store)).changed).toEqual([]);
    expect(renderImpact(await impact(store))).toContain('No impact');
  });

  it('follows a changed input to everything built from it, and reopens the earliest gate', async () => {
    const store = await project();
    await store.write('inputs/srs.md', '# SRS v2: EU data residency');
    const report = await impact(store);
    expect(report.changed).toEqual([{ input: 'inputs/srs.md', usedBy: ['00-drivers.md'] }]);
    expect(report.affected).toEqual(['00-drivers.md', 'decisions/ADR-0001-style.md', 'stack.md']);
    expect(report.earliestGate).toBe('G0');

    const marked = await markStale(store, report.affected);
    expect(marked).toHaveLength(3);
    const snap = await snapshot(store);
    expect(snap.gates[0]).toMatchObject({ gate: 'G0', state: 'open' });
    expect(snap.files.find((f) => f.path === '00-drivers.md')?.state).toBe('stale');
    expect(await markStale(store, report.affected)).toEqual([]);
    expect(renderImpact(report, marked)).toContain('Earliest affected gate: G0');
  });
});
