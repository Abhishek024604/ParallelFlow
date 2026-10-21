import { describe, expect, it } from 'vitest';
import { archDocName, archPathOf, isArchDocName } from './arch-docs.js';
import { hasUnsafeNameChars } from './files.js';

describe('arch/ files as documents', () => {
  it('names them with › for each folder, a name documents may have', () => {
    expect(archDocName('hld/flows/checkout.drawio')).toBe('arch › hld › flows › checkout.drawio');
    expect(archDocName('arch/00-drivers.md')).toBe('arch › 00-drivers.md');
    expect(hasUnsafeNameChars(archDocName('lld/CMP-003/openapi.yaml'))).toBe(false);
  });

  it('maps a document name back to its arch/ path, and nothing else', () => {
    expect(archPathOf('arch › lld › CMP-003 › lld.md')).toBe('lld/CMP-003/lld.md');
    expect(archPathOf(archDocName('inputs/srs.md'))).toBe('inputs/srs.md');
    expect(isArchDocName('Release notes.md')).toBe(false);
    expect(isArchDocName('architecture.md')).toBe(false);
    expect(archPathOf('arch › ')).toBeNull();
  });
});
