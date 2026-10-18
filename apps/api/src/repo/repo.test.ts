import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@saras/observability';
import { describe, expect, it } from 'vitest';
import { ArenaRepos } from './git.js';
import { fileName, renderReadme } from './snapshot.js';

const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
const PROJECT = '01a14942-37ef-7b65-af3f-0528bbf18680';
const author = { name: 'Riya', email: 'riya@example.com' };

describe('arena repo', () => {
  it('commits each approved state once, keeps files inside the repo and reads them back', async () => {
    const repos = new ArenaRepos(mkdtempSync(join(tmpdir(), 'saras-repo-test-')), logger);
    const files = [
      { path: 'README.md', content: '# Arena' },
      { path: 'cycle-1/plan/goal.md', content: 'Goal' },
      { path: '../outside.md', content: 'never written' },
    ];
    expect(await repos.commit(PROJECT, { files, message: 'Approve PLAN gate', author })).toMatch(
      /^[0-9a-f]{40}$/,
    );
    expect(await repos.commit(PROJECT, { files, message: 'Same', author })).toBeNull();
    const { commits, files: tree } = await repos.read(PROJECT);
    expect(commits.map((c) => [c.message, c.author])).toEqual([['Approve PLAN gate', 'Riya']]);
    expect(tree.map((f) => f.path).sort()).toEqual(['README.md', 'cycle-1/plan/goal.md']);
    expect((await repos.show(PROJECT, 'cycle-1/plan/goal.md'))?.toString()).toBe('Goal');
    expect(await repos.show(PROJECT, '../outside.md')).toBeNull();
  });

  it('names files safely', () => {
    expect(fileName('Checkout spec: v2/final')).toBe('Checkout spec- v2-final.md');
    expect(fileName('notes.txt')).toBe('notes.txt');
    expect(fileName('../..')).toBe('untitled.md');
  });

  it('links both logs and every approved document from the README', () => {
    const readme = renderReadme({ name: 'Checkout', description: null }, [
      { path: 'cycle-1/plan/plan.md', content: '' },
    ]);
    expect(readme).toContain('- [progress.md](progress.md)');
    expect(readme).toContain('- [state.md](state.md)');
    expect(readme).toContain('- [cycle-1/plan/plan.md](cycle-1/plan/plan.md)');
  });
});
