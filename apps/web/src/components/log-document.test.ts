import { describe, expect, it } from 'vitest';
import { splitSections } from './log-document';

describe('log documents', () => {
  it('splits a log at its sections, keeping the overview first', () => {
    const sections = splitSections(
      '# Arena state\n\n> Intro\n\n## Key decisions\n\n- **A**\n\n## Open questions\n\n- B?\n',
    );
    expect(sections.map((s) => s.title)).toEqual([null, 'Key decisions', 'Open questions']);
    expect(sections[1]!.body.trim()).toBe('- **A**');
  });
});
