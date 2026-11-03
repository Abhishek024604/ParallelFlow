import { describe, expect, it } from 'vitest';
import { githubPullFrom, pullEventAction, pushFacts, statusOf } from './pulls.js';

const sha = (c: string) => c.repeat(40);

function payload(action: string, pr: Record<string, unknown> = {}) {
  return {
    action,
    pull_request: {
      number: 7,
      title: '  Checkout: pay by card  ',
      body: 'Implements STORY-007',
      html_url: 'https://github.com/acme/shop/pull/7',
      state: 'open',
      draft: false,
      merged: false,
      merged_at: null,
      merge_commit_sha: sha('c'),
      head: { ref: 'feat/story-007-pay-by-card', sha: sha('a') },
      base: { ref: 'main' },
      user: { login: 'dev-ann' },
      ...pr,
    },
  };
}

describe('GitHub pull request webhook mapping', () => {
  it('maps an opened pull request to an open mirror row', () => {
    expect(githubPullFrom(payload('opened'))).toEqual({
      number: 7,
      title: 'Checkout: pay by card',
      description: 'Implements STORY-007',
      htmlUrl: 'https://github.com/acme/shop/pull/7',
      state: 'open',
      headRef: 'feat/story-007-pay-by-card',
      headSha: sha('a'),
      base: 'main',
      authorLogin: 'dev-ann',
      mergedAt: null,
      mergeSha: null,
    });
  });

  it('follows draft, merged and closed states', () => {
    expect(githubPullFrom(payload('converted_to_draft', { draft: true }))?.state).toBe('draft');
    const merged = githubPullFrom(
      payload('closed', { state: 'closed', merged: true, merged_at: '2026-10-28T10:00:00Z' }),
    );
    expect(merged).toMatchObject({ state: 'merged', mergeSha: sha('c') });
    expect(merged?.mergedAt?.toISOString()).toBe('2026-10-28T10:00:00.000Z');
    expect(githubPullFrom(payload('closed', { state: 'closed' }))?.state).toBe('closed');
    expect(statusOf('draft')).toBe('open');
    expect(statusOf('merged')).toBe('merged');
  });

  it('ignores other actions and malformed payloads', () => {
    expect(githubPullFrom(payload('labeled'))).toBeNull();
    expect(
      githubPullFrom(payload('opened', { html_url: 'https://evil.example/pull/7' })),
    ).toBeNull();
    expect(githubPullFrom(payload('opened', { head: { ref: 'x', sha: 'nope' } }))).toBeNull();
    expect(githubPullFrom({ action: 'opened' })).toBeNull();
    expect(githubPullFrom(payload('opened', { user: { login: 'bad login!' } }))?.authorLogin).toBe(
      null,
    );
  });
});

describe('activity events from webhooks (ADR-044)', () => {
  it('maps pull request actions', () => {
    expect(pullEventAction('opened', 'open')).toBe('repo.pr.opened');
    expect(pullEventAction('closed', 'merged')).toBe('repo.pr.merged');
    expect(pullEventAction('closed', 'closed')).toBe('repo.pr.closed');
    expect(pullEventAction('synchronize', 'open')).toBe('repo.pr.updated');
    expect(pullEventAction('labeled', 'open')).toBeNull();
  });

  it('reads a push, and ignores ParallelFlow log commits, tags and deleted branches', () => {
    const push = pushFacts({
      ref: 'refs/heads/main',
      after: 'abcdef1234567890abcdef1234567890abcdef12',
      sender: { login: 'ravi-gh' },
      commits: [{ message: 'Add login\n\nlong body' }, { message: 'Update logs: activity' }],
    });
    expect(push).toEqual({
      branch: 'main',
      count: 1,
      head: 'abcdef1',
      subjects: ['Add login'],
      pusher: 'ravi-gh',
    });
    expect(
      pushFacts({ ref: 'refs/heads/main', commits: [{ message: 'Update progress and state' }] }),
    ).toBeNull();
    expect(pushFacts({ ref: 'refs/tags/v1', commits: [] })).toBeNull();
    expect(pushFacts({ ref: 'refs/heads/x', deleted: true, commits: [] })).toBeNull();
  });
});
