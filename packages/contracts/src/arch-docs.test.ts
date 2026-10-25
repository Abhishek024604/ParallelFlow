import { describe, expect, it } from 'vitest';
import { ARCH_STATE_NAME, archDocName, archPathOf, isArchDocName } from './arch-docs.js';
import { hasUnsafeNameChars } from './files.js';
import { isStandardFileName } from './file-names.js';

const PATHS = [
  'inputs/srs.md',
  'inputs/goal.md',
  'inputs/meeting-summary.md',
  'inputs/governance.yaml',
  '00-drivers.md',
  'stack.md',
  'model.yaml',
  'risks.md',
  'reviews/hld-review.md',
  '.swa/state.json',
  'hld/hld.md',
  'hld/containers.drawio',
  'hld/context.drawio',
  'hld/flows/checkout.drawio',
  'hld/sketches/containers.excalidraw',
  'lld/CMP-003/lld.md',
  'lld/CMP-003/openapi.yaml',
  'lld/CMP-12/schemas/order.json',
  'decisions/ADR-0001-use-postgres.md',
  'reviews/code-auth.md',
  'reviews/impact-billing.md',
  'fitness/latency/p95.md',
  'hld/flow-x.drawio',
  'x86.s',
];

describe('arch/ files as standard documents', () => {
  it('names every SWA path with a standard name that maps back to the same path', () => {
    for (const path of PATHS) {
      const name = archDocName(path);
      expect(isStandardFileName(name), `${path} → ${name}`).toBe(true);
      expect(hasUnsafeNameChars(name)).toBe(false);
      expect(archPathOf(name), name).toBe(path);
    }
  });

  it('uses the plain names a team would use', () => {
    expect(archDocName('arch/hld/hld.md')).toBe('hld.md');
    expect(archDocName('inputs/srs.md')).toBe('requirements.md');
    expect(archDocName('lld/CMP-003/lld.md')).toBe('lld-CMP-003.md');
    expect(archDocName('stack.md')).toBe('architecture-stack.md');
    expect(archDocName('.swa/state.json')).toBe(ARCH_STATE_NAME);
    // A name that would read back as another path falls back to the generic form.
    expect(archDocName('hld/flow-x.drawio')).toBe('architecture-arch--hld--flow-x.drawio.md');
  });

  it('still reads names saved before the rule, and ignores ordinary files', () => {
    expect(archPathOf('arch › lld › CMP-003 › lld.md')).toBe('lld/CMP-003/lld.md');
    expect(archPathOf('arch › ')).toBeNull();
    expect(isArchDocName('plan.md')).toBe(false);
    expect(isArchDocName('test-e2e.md')).toBe(false);
  });
});
