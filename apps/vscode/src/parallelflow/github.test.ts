import { describe, expect, it } from 'vitest';
import type { GitRunner } from './git.js';
import {
  type GithubRepo,
  GithubGit,
  GithubRest,
  githubGitEnv,
  parseStory,
  pullBody,
  pullTitle,
  slugify,
  taskBranch,
} from './github.js';

const repo: GithubRepo = {
  owner: 'acme',
  name: 'shop',
  fullName: 'acme/shop',
  htmlUrl: 'https://github.com/acme/shop',
  cloneUrl: 'https://github.com/acme/shop.git',
  defaultBranch: 'main',
};
const TOKEN = 'gho_secretToken123';

describe('building from GitHub', () => {
  it('names task branches from the story', () => {
    expect(slugify('Pay by card — Visa & Mastercard!')).toBe('pay-by-card-visa-mastercard');
    expect(slugify('***')).toBe('task');
    expect(taskBranch('Pay by card', 'STORY-007')).toBe('feat/story-007-pay-by-card');
    expect(taskBranch('STORY-007: Pay by card', 'STORY-007')).toBe('feat/story-007-pay-by-card');
    expect(taskBranch('Fix the login flicker')).toBe('feat/fix-the-login-flicker');
  });

  it('reads a story from its backlog file', () => {
    expect(parseStory('STORY-007-pay.md', '# STORY-007: Pay by card\n\nAs a buyer…')).toEqual({
      id: 'STORY-007',
      title: 'Pay by card',
      path: 'docs/product/backlog/STORY-007-pay.md',
    });
    expect(parseStory('story-12.md', '---\ntitle: "Refunds"\n---\n# x')).toMatchObject({
      id: 'STORY-12',
      title: 'Refunds',
    });
    expect(
      parseStory(
        'requirements-story-002.md',
        '# TrackFlow - Story 002\n\n**Title**: Tasks & Priorities on a Project Board\n',
        'docs/plan',
      ),
    ).toEqual({
      id: 'STORY-002',
      title: 'Tasks & Priorities on a Project Board',
      path: 'docs/plan/requirements-story-002.md',
    });
    expect(parseStory('README.md', '# Backlog')).toBeUndefined();
  });

  it('renders the pull request title and body', () => {
    const story = {
      id: 'STORY-007',
      title: 'Pay by card',
      path: 'docs/product/backlog/STORY-007.md',
    };
    expect(pullTitle('ignored', story)).toBe('STORY-007: Pay by card');
    const body = pullBody({
      summary: ['feat: card form', 'test: card form'],
      story,
      docs: ['docs/design/architecture/stack.md'],
      repo,
      branch: 'feat/story-007-pay-by-card',
      checks: [
        { name: 'pnpm test', status: 'passed' },
        { name: 'pnpm lint', status: 'failed' },
      ],
    });
    expect(body).toContain('- feat: card form');
    expect(body).toContain(
      'Implements STORY-007: [Pay by card](https://github.com/acme/shop/blob/feat/story-007-pay-by-card/docs/product/backlog/STORY-007.md)',
    );
    expect(body).toContain(
      '- [docs/design/architecture/stack.md](https://github.com/acme/shop/blob/feat/story-007-pay-by-card/docs/design/architecture/stack.md)',
    );
    expect(body).toContain('- [x] `pnpm test` passed');
    expect(body).toContain('- [ ] `pnpm lint` failed');
  });

  it('gives the token to git only through the environment, never argv', async () => {
    const calls: { args: string[]; env?: Readonly<Record<string, string>> }[] = [];
    const run: GitRunner = (args, _cwd, env) => {
      calls.push({ args, env });
      return Promise.resolve(args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '');
    };
    const git = new GithubGit(() => Promise.resolve(TOKEN), run);
    await git.clone(repo, '/work/shop');
    await git.startBranch('/work/shop', repo, 'feat/story-007-pay-by-card');
    await git.push('/work/shop', repo, 'feat/story-007-pay-by-card');
    await expect(git.push('/work/shop', repo, 'main')).rejects.toThrow();
    expect(calls.length).toBeGreaterThan(3);
    for (const c of calls) expect(c.args.join(' ')).not.toContain(TOKEN);
    const authed = calls.filter((c) => c.env);
    expect(authed.map((c) => c.args[0])).toEqual(['clone', 'fetch', 'push']);
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(githubGitEnv(TOKEN)).toMatchObject({
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    });
    expect(calls.find((c) => c.args[0] === 'config')?.args).toEqual([
      'config',
      'remote.origin.pushurl',
      'no-push://use-parallelflow-open-pull-request',
    ]);
  });

  it('finds the open pull request for a branch before creating one', async () => {
    const seen: string[] = [];
    const rest = new GithubRest(TOKEN, (url, init) => {
      seen.push(`${init.method} ${url}`);
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    expect(await rest.findPull(repo, 'feat/story-007-x')).toBeUndefined();
    expect(seen[0]).toBe(
      'GET https://api.github.com/repos/acme/shop/pulls?head=acme%3Afeat%2Fstory-007-x&state=open',
    );
  });
});
