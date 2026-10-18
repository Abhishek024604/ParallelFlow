import { describe, expect, it } from 'vitest';
import { rendersAsMarkdown } from './files';

describe('rendersAsMarkdown (full-screen and repo viewers)', () => {
  it('renders Markdown and extension-less files, shows code and data as text', () => {
    expect(rendersAsMarkdown('plan.md')).toBe(true);
    expect(rendersAsMarkdown('README')).toBe(true);
    expect(rendersAsMarkdown('src/app.ts')).toBe(false);
    expect(rendersAsMarkdown('data.json')).toBe(false);
  });
});
