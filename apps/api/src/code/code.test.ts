import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '@parallelflow/observability';
import { describe, expect, it } from 'vitest';
import { ArenaRepos, BundleError, isManagedPath, MergeConflictError } from '../repo/git.js';
import {
  branchFor,
  mergeBlocker,
  pushBranchError,
  reviewedStatus,
  reviewError,
  SESSION_BRANCH,
  type ReviewFact,
} from './rules.js';

const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;
const PROJECT = '01a14942-37ef-7b65-af3f-0528bbf18681';
const AUTHOR = 'author';
const LEAD = 'lead';
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

describe('branch names', () => {
  it('makes ai/<slug>-<hex> branches the database accepts', () => {
    expect(branchFor('Add login with Google!', '1a2b')).toBe('ai/add-login-with-google-1a2b');
    expect(branchFor('???', '00ff')).toBe('ai/task-00ff');
    expect(branchFor('x'.repeat(90))).toMatch(SESSION_BRANCH);
  });

  it('lets a push write only its own session branch, never main', () => {
    const own = 'ai/add-login-1a2b';
    expect(pushBranchError(undefined, own)).toBeNull();
    expect(pushBranchError(own, own)).toBeNull();
    expect(pushBranchError(`refs/heads/${own}`, own)).toBeNull();
    expect(pushBranchError('main', own)).toMatch(/pull request/);
    expect(pushBranchError('refs/heads/main', own)).toMatch(/pull request/);
    expect(pushBranchError('feature/x', own)).toMatch(/ai\/\*/);
    expect(pushBranchError('ai/other-task-9f9f', own)).toMatch(/only/);
    expect(pushBranchError('ai/../main-1a2b', own)).not.toBeNull();
  });
});

describe('reviews and merging', () => {
  const pr = { status: 'open' as const, authorId: AUTHOR, headSha: H2 };
  const review = (reviewerId: string, decision: ReviewFact['decision'], headSha = H2, at = 1) => ({
    reviewerId,
    decision,
    headSha,
    at,
  });

  it('never lets the author approve, and needs pr.merge to approve', () => {
    expect(reviewError(pr, AUTHOR, 'approve', true)).toMatch(/your own/);
    expect(reviewError(pr, LEAD, 'approve', false)).toMatch(/can merge/);
    expect(reviewError(pr, LEAD, 'approve', true)).toBeNull();
    expect(reviewError(pr, AUTHOR, 'comment', false)).toBeNull();
    expect(reviewError({ ...pr, status: 'merged' }, LEAD, 'comment', true)).toMatch(/closed/);
  });

  it('merges only with an approval of the current head and no standing change request', () => {
    expect(mergeBlocker(pr, [])).toMatch(/approval/);
    expect(mergeBlocker(pr, [review(LEAD, 'approve', H1)])).toMatch(/latest commits/);
    expect(mergeBlocker(pr, [review(AUTHOR, 'approve')])).toMatch(/other than the author/);
    expect(mergeBlocker(pr, [review(LEAD, 'approve')])).toBeNull();
    expect(
      mergeBlocker(pr, [review(LEAD, 'approve', H2, 1), review('qa', 'request_changes', H2, 2)]),
    ).toMatch(/Changes were requested/);
    // The reviewer approved after asking for changes: their latest decision counts.
    expect(
      mergeBlocker(pr, [review(LEAD, 'request_changes', H2, 1), review(LEAD, 'approve', H2, 2)]),
    ).toBeNull();
    // A comment does not cancel an approval.
    expect(
      mergeBlocker(pr, [review(LEAD, 'approve', H2, 1), review(LEAD, 'comment', H2, 2)]),
    ).toBeNull();
    expect(mergeBlocker({ ...pr, status: 'closed' }, [review(LEAD, 'approve')])).toMatch(/closed/);
  });

  it('derives the status from the reviews of the current head', () => {
    expect(reviewedStatus(pr, [review(LEAD, 'approve')])).toBe('approved');
    expect(reviewedStatus(pr, [review(LEAD, 'approve', H1)])).toBe('open');
    expect(reviewedStatus(pr, [review('qa', 'request_changes')])).toBe('changes_requested');
  });
});

describe('arena repo branches and pull requests', { timeout: 60_000 }, () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=AI', '-c', 'user.email=ai@x', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
    }).trim();

  it('bundles, takes a pushed branch, diffs it, merges it and keeps code through a snapshot', async () => {
    const repos = new ArenaRepos(mkdtempSync(join(tmpdir(), 'parallelflow-code-test-')), logger);
    const author = { name: 'Riya', email: 'riya@example.com' };
    const main = await repos.ensureHead(PROJECT, async () => ({
      files: [{ path: 'README.md', content: '# Arena\n' }],
      message: 'Start',
      author,
    }));
    expect(main).toMatch(/^[0-9a-f]{40}$/);
    expect(await repos.ensureHead(PROJECT, () => Promise.reject(new Error('not again')))).toBe(
      main,
    );

    // The extension clones from the bundle and commits on its branch.
    const work = mkdtempSync(join(tmpdir(), 'parallelflow-code-clone-'));
    const bundleFile = join(work, '..', `${PROJECT}-${Date.now()}.bundle`);
    writeFileSync(bundleFile, await repos.bundle(PROJECT));
    const clone = join(work, 'repo');
    git(work, 'clone', '-q', '-b', 'main', bundleFile, clone);
    const branch = 'ai/add-hello-1a2b';
    git(clone, 'checkout', '-q', '-b', branch);
    writeFileSync(join(clone, 'hello.ts'), 'export const hello = 1;\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'Add hello');
    git(clone, 'checkout', '-q', '-b', 'main-evil');
    const push = join(work, 'push.bundle');
    git(clone, 'bundle', 'create', '-q', push, `main..${branch}`, branch);

    await expect(repos.fetchBundle(PROJECT, 'main', readFileSync(push))).rejects.toBeInstanceOf(
      BundleError,
    );
    await expect(
      repos.fetchBundle(PROJECT, 'ai/other-1a2b', readFileSync(push)),
    ).rejects.toBeInstanceOf(BundleError);
    await expect(repos.fetchBundle(PROJECT, branch, Buffer.from('nope'))).rejects.toBeInstanceOf(
      BundleError,
    );
    const head = await repos.fetchBundle(PROJECT, branch, readFileSync(push));
    expect(head).toBe(git(clone, 'rev-parse', branch));

    const [info] = await repos.branches(PROJECT);
    expect(info).toMatchObject({ name: branch, sha: head, ahead: 1 });
    const diff = await repos.pullDiff(PROJECT, head);
    expect(diff.commits.map((c) => c.message)).toEqual(['Add hello']);
    expect(diff.files).toMatchObject([{ path: 'hello.ts', status: 'added', additions: 1 }]);
    expect(diff.files[0]?.patch).toContain('+export const hello = 1;');

    const merged = await repos.merge(PROJECT, {
      sha: head,
      message: 'Merge PR #1: Add hello',
      author,
    });
    expect((await repos.show(PROJECT, 'hello.ts'))?.toString()).toBe('export const hello = 1;\n');
    expect(await repos.aheadOf(PROJECT, head)).toBe(0);
    expect((await repos.pullDiff(PROJECT, head, `${merged}^1`)).files).toHaveLength(1);

    // A gate snapshot replaces its own files and keeps the merged code.
    await repos.commit(PROJECT, {
      files: [
        { path: 'README.md', content: '# Arena v2\n' },
        { path: 'docs/a.md', content: 'A' },
      ],
      message: 'Approve PLAN gate',
      author,
    });
    const { files } = await repos.read(PROJECT);
    expect(files.map((f) => f.path).sort()).toEqual(['README.md', 'docs/a.md', 'hello.ts']);
    expect(isManagedPath('cycle-2')).toBe(true);
    expect(isManagedPath('src')).toBe(false);
  });

  it('aborts a conflicting merge and leaves main as it was', async () => {
    const repos = new ArenaRepos(mkdtempSync(join(tmpdir(), 'parallelflow-code-test-')), logger);
    const author = { name: 'Riya', email: 'riya@example.com' };
    await repos.ensureHead(PROJECT, async () => ({
      files: [{ path: 'README.md', content: '# Arena\n' }],
      message: 'Start',
      author,
    }));
    const work = mkdtempSync(join(tmpdir(), 'parallelflow-code-clone-'));
    const bundleFile = join(work, 'in.bundle');
    writeFileSync(bundleFile, await repos.bundle(PROJECT));
    const clone = join(work, 'repo');
    git(work, 'clone', '-q', '-b', 'main', bundleFile, clone);
    git(clone, 'checkout', '-q', '-b', 'ai/readme-0001');
    writeFileSync(join(clone, 'README.md'), '# Changed by AI\n');
    git(clone, 'commit', '-q', '-am', 'Edit readme');
    const push = join(work, 'push.bundle');
    git(clone, 'bundle', 'create', '-q', push, 'main..ai/readme-0001', 'ai/readme-0001');
    const head = await repos.fetchBundle(PROJECT, 'ai/readme-0001', readFileSync(push));
    await repos.commit(PROJECT, {
      files: [{ path: 'README.md', content: '# Changed by a gate\n' }],
      message: 'Gate',
      author,
    });
    const before = (await repos.read(PROJECT)).commits[0]?.sha;
    await expect(
      repos.merge(PROJECT, { sha: head, message: 'Merge', author }),
    ).rejects.toBeInstanceOf(MergeConflictError);
    expect((await repos.read(PROJECT)).commits[0]?.sha).toBe(before);
    expect((await repos.show(PROJECT, 'README.md'))?.toString()).toBe('# Changed by a gate\n');
  });
});
