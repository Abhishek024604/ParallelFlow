import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '@parallelflow/observability';
import { describe, expect, it } from 'vitest';
import { ArenaRepos, isManagedPath, remoteAuthEnv } from './git.js';
import { docPath, fileName, renderReadme } from './snapshot.js';

const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
const PROJECT = '01a14942-37ef-7b65-af3f-0528bbf18680';
const author = { name: 'Riya', email: 'riya@example.com' };

describe('arena repo', () => {
  it('commits each approved state once, keeps files inside the repo and reads them back', async () => {
    const repos = new ArenaRepos(mkdtempSync(join(tmpdir(), 'parallelflow-repo-test-')), logger);
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
    expect(readme).toContain('- [PROGRESS.md](PROGRESS.md)');
    expect(readme).toContain('- [STATE.md](STATE.md)');
    expect(readme).toContain('- [cycle-1/plan/plan.md](cycle-1/plan/plan.md)');
  });

  it('files approved documents at stable paths under docs/', () => {
    expect(docPath('plan.md', 'PLAN')).toBe('docs/plan/plan.md');
    expect(docPath('requirements.md', 'PLAN')).toBe('docs/plan/requirements.md');
    expect(docPath('hld.md', 'DESIGN')).toBe('docs/design/architecture/hld/hld.md');
    expect(docPath('lld-CMP-001--openapi.yaml', null)).toBe(
      'docs/design/architecture/lld/CMP-001/openapi.yaml',
    );
    expect(docPath('architecture-ADR-0003-use-postgres.md', null)).toBe(
      'docs/design/architecture/decisions/ADR-0003-use-postgres.md',
    );
    expect(docPath('architecture-model.yaml', null)).toBe('docs/design/architecture/model.yaml');
    expect(docPath('lld-auth.md', null)).toBe('docs/design/lld-auth.md');
    expect(docPath('test-e2e.md', null)).toBe('docs/test/test-e2e.md');
    expect(docPath('pm › backlog › STORY-001.md', null)).toBe('docs/product/backlog/STORY-001.md');
    expect(docPath('Backlog › requirements-story-001.md', null)).toBe(
      'docs/plan/Backlog/requirements-story-001.md',
    );
    expect(docPath('HLD › Flows › hld-checkout.drawio', null)).toBe(
      'docs/design/HLD/Flows/hld-checkout.drawio',
    );
    expect(docPath('Launch notes', 'DEPLOY')).toBe('docs/deploy/Launch notes.md');
    expect(docPath('architecture-swa-state.json', null)).toBeNull();
    expect(isManagedPath('AGENTS.md')).toBe(true);
    expect(isManagedPath('docs/design')).toBe(true);
    expect(isManagedPath('cycle-2')).toBe(true);
    expect(isManagedPath('AGENTS.local.md')).toBe(false);
    expect(isManagedPath('docs/api')).toBe(false);
    expect(isManagedPath('src')).toBe(false);
  });

  it('keeps the token out of argv and the URL: git gets it as an extra header', () => {
    const env = remoteAuthEnv('https://github.com/acme/shop.git', 'ghs_secret');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`,
    );
  });

  it('pushes commits to the remote on top of its branch and follows pushes made there', async () => {
    const root = mkdtempSync(join(tmpdir(), 'parallelflow-remote-test-'));
    const bare = join(root, 'origin.git');
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], {
        cwd,
        encoding: 'utf8',
      }).trim();
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    const repos = new ArenaRepos(join(root, 'arenas'), logger);
    const reports: (string | null)[] = [];
    const scope = { orgId: '01a14942-37ef-7b65-af3f-0528bbf18681', projectId: PROJECT };
    repos.useRemotes({
      resolve: async () => ({
        url: pathToFileURL(bare).href,
        branch: 'main',
        token: async () => 'token',
      }),
      report: (_, error) => reports.push(error),
    });
    const files = [{ path: 'README.md', content: '# Arena' }];
    const first = await repos.commit(
      PROJECT,
      { files, message: 'Approve PLAN gate', author },
      scope.orgId,
    );
    expect(git(root, '--git-dir', bare, 'rev-parse', 'main')).toBe(first);

    // Someone pushes code on GitHub; the arena follows, and the next snapshot keeps it.
    const clone = join(root, 'clone');
    git(root, 'clone', '-q', bare, clone);
    execFileSync('node', ['-e', "require('fs').writeFileSync('app.ts', 'code')"], { cwd: clone });
    git(clone, 'add', 'app.ts');
    git(clone, 'commit', '-q', '-m', 'Add code');
    git(clone, 'push', '-q', 'origin', 'main');
    await repos.pull(scope);
    expect((await repos.read(PROJECT)).commits[0]?.message).toBe('Add code');
    const second = await repos.commit(
      PROJECT,
      {
        files: [{ path: 'README.md', content: '# Arena v2' }],
        message: 'Approve DESIGN gate',
        author,
      },
      scope.orgId,
    );
    expect(git(root, '--git-dir', bare, 'rev-parse', 'main')).toBe(second);
    expect(git(root, '--git-dir', bare, 'log', '--format=%s', 'main')).toBe(
      'Approve DESIGN gate\nAdd code\nApprove PLAN gate',
    );
    expect((await repos.show(PROJECT, 'app.ts'))?.toString()).toBe('code');
    expect(reports.every((r) => r === null)).toBe(true);
  }, 60_000);
});
