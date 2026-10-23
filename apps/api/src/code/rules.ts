import { randomBytes } from 'node:crypto';
import type { PullRequestStatus, ReviewDecision } from '@parallelflow/contracts';

// Pure rules of AI coding sessions and pull requests (ADR-037): branch names, who may review, and
// when a PR may be merged. Unit tested; the database adds a RESTRICTIVE policy for self-approval.

export const PR_MERGE = 'pr.merge';

/** An AI coding branch: `ai/<slug>-<4 hex>` (same pattern as the coding_sessions CHECK). */
export const SESSION_BRANCH = /^ai\/[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?-[0-9a-f]{4}$/;

/** `ai/<slug of the title>-<4 hex>`. */
export function branchFor(title: string, suffix = randomBytes(2).toString('hex')): string {
  const slug =
    title
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'task';
  return `ai/${slug}-${suffix}`;
}

/** A push may only write its own session's `ai/*` branch, never main or anything else. */
export function pushBranchError(requested: unknown, sessionBranch: string): string | null {
  if (typeof requested !== 'string' || requested === '') return null; // defaults to the session's
  const name = requested.replace(/^refs\/heads\//, '');
  if (name === 'main' || name === 'master')
    return 'main can only change by merging a pull request.';
  if (!SESSION_BRANCH.test(name)) return 'Only ai/* branches can be pushed.';
  if (name !== sessionBranch) return `This coding session pushes to ${sessionBranch} only.`;
  return null;
}

export interface ReviewFact {
  reviewerId: string;
  decision: ReviewDecision;
  headSha: string;
  /** Ordered oldest first. */
  at: number;
}

export interface PullFacts {
  status: PullRequestStatus;
  authorId: string;
  headSha: string;
}

export function isOpen(status: PullRequestStatus): boolean {
  return status === 'open' || status === 'approved' || status === 'changes_requested';
}

/** Why `reviewerId` may not give `decision` (403 text), or null. */
export function reviewError(
  pr: PullFacts,
  reviewerId: string,
  decision: ReviewDecision,
  canMerge: boolean,
): string | null {
  if (!isOpen(pr.status)) return 'This pull request is closed.';
  if (decision !== 'approve') return null;
  if (reviewerId === pr.authorId) return 'You cannot approve your own pull request.';
  if (!canMerge) return 'Only teammates who can merge pull requests can approve them.';
  return null;
}

/** Each reviewer's latest approve / request_changes (comments do not count). */
function latestDecisions(reviews: readonly ReviewFact[]): ReviewFact[] {
  const latest = new Map<string, ReviewFact>();
  for (const r of [...reviews].sort((a, b) => a.at - b.at)) {
    if (r.decision !== 'comment') latest.set(r.reviewerId, r);
  }
  return [...latest.values()];
}

/** The PR status after its reviews (open PRs only). */
export function reviewedStatus(pr: PullFacts, reviews: readonly ReviewFact[]): PullRequestStatus {
  if (!isOpen(pr.status)) return pr.status;
  const current = latestDecisions(reviews).filter((r) => r.headSha === pr.headSha);
  if (current.some((r) => r.decision === 'request_changes')) return 'changes_requested';
  if (current.some((r) => r.decision === 'approve' && r.reviewerId !== pr.authorId)) {
    return 'approved';
  }
  return 'open';
}

/**
 * Why the PR cannot be merged yet, or null: it needs an approval of the current head by someone
 * other than the author, and no change request on the current head still standing.
 */
export function mergeBlocker(pr: PullFacts, reviews: readonly ReviewFact[]): string | null {
  if (pr.status === 'merged') return 'Already merged.';
  if (pr.status === 'closed') return 'This pull request is closed.';
  const current = latestDecisions(reviews).filter((r) => r.headSha === pr.headSha);
  if (current.some((r) => r.decision === 'request_changes')) {
    return 'Changes were requested on the latest commits.';
  }
  if (!current.some((r) => r.decision === 'approve' && r.reviewerId !== pr.authorId)) {
    return 'It needs an approval of the latest commits from someone other than the author.';
  }
  return null;
}
