import type { GithubPullState } from '@parallelflow/contracts';
import { type ArenaEventAction, recordArenaEvent, type Tx } from '@parallelflow/db';
import { sql } from 'kysely';

// GitHub pull requests in the arena's list (ADR-042). The pull_request webhook (verified and
// deduplicated per delivery in github.ts) maps the payload here and upserts one row per GitHub
// number. The row is a mirror: reviews and merges happen on GitHub. Payload text other than the
// title and body is never stored or logged.

/** The pull_request actions that change what the arena shows. */
export const PULL_ACTIONS = new Set([
  'opened',
  'reopened',
  'edited',
  'synchronize',
  'closed',
  'ready_for_review',
  'converted_to_draft',
]);

const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
const REF = /^(?!-)[^\s~^:?*[\\\0]{1,255}$/;

export interface GithubPull {
  number: number;
  title: string;
  description: string;
  htmlUrl: string;
  state: GithubPullState;
  headRef: string;
  headSha: string;
  base: string;
  authorLogin: string | null;
  mergedAt: Date | null;
  mergeSha: string | null;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The pull request in a pull_request payload, or null when it is not one we can mirror. */
export function githubPullFrom(payload: Record<string, unknown>): GithubPull | null {
  if (!PULL_ACTIONS.has(String(payload.action))) return null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr) return null;
  const number = pr.number;
  const head = (pr.head ?? {}) as Record<string, unknown>;
  const base = (pr.base ?? {}) as Record<string, unknown>;
  const user = (pr.user ?? {}) as Record<string, unknown>;
  const htmlUrl = str(pr.html_url);
  const headRef = str(head.ref);
  const headSha = str(head.sha);
  const baseRef = str(base.ref);
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
  if (!htmlUrl || !/^https:\/\/github\.com\/[A-Za-z0-9._/-]{1,300}$/.test(htmlUrl)) return null;
  if (!headRef || !REF.test(headRef) || !baseRef || !REF.test(baseRef)) return null;
  if (!headSha || !SHA.test(headSha)) return null;
  const merged = pr.merged === true || (typeof pr.merged_at === 'string' && pr.state === 'closed');
  const mergedAt = merged && typeof pr.merged_at === 'string' ? new Date(pr.merged_at) : null;
  const state: GithubPullState =
    mergedAt && !Number.isNaN(mergedAt.getTime())
      ? 'merged'
      : pr.state === 'closed'
        ? 'closed'
        : pr.draft === true
          ? 'draft'
          : 'open';
  const login = str(user.login);
  const mergeSha = str(pr.merge_commit_sha);
  const title = (str(pr.title) ?? '').trim().slice(0, 200) || `Pull request #${number}`;
  return {
    number,
    title,
    description: (str(pr.body) ?? '').slice(0, 20000),
    htmlUrl,
    state,
    headRef,
    headSha,
    base: baseRef,
    authorLogin: login && LOGIN.test(login) ? login : null,
    mergedAt: state === 'merged' ? mergedAt : null,
    mergeSha: state === 'merged' && mergeSha && SHA.test(mergeSha) ? mergeSha : null,
  };
}

/** The pull_requests status the arena shows for a GitHub state. */
export function statusOf(state: GithubPullState): 'open' | 'closed' | 'merged' {
  return state === 'merged' ? 'merged' : state === 'closed' ? 'closed' : 'open';
}

/** The activity log's event for a pull_request webhook action (ADR-044), or null. */
export function pullEventAction(action: string, state: GithubPullState): ArenaEventAction | null {
  if (action === 'opened') return 'repo.pr.opened';
  if (action === 'reopened') return 'repo.pr.reopened';
  if (action === 'closed') return state === 'merged' ? 'repo.pr.merged' : 'repo.pr.closed';
  if (PULL_ACTIONS.has(action)) return 'repo.pr.updated';
  return null;
}

/** A GitHub login as an actor label, or null. */
export function loginOf(value: unknown): string | null {
  const login = (value as { login?: unknown } | undefined)?.login;
  return typeof login === 'string' && LOGIN.test(login) ? login : null;
}

/** Inserts or updates the mirror row (in the arena's org, as a system job). */
export async function upsertGithubPull(
  tx: Tx,
  scope: { orgId: string; projectId: string },
  pull: GithubPull,
  /** The webhook's action and who sent it, for the activity log. */
  event?: { action: string; sender: string | null },
): Promise<void> {
  const logAction = event ? pullEventAction(event.action, pull.state) : null;
  const record = async (id: string) => {
    if (!logAction || !event) return;
    await recordArenaEvent(
      tx,
      scope,
      { type: 'service', label: event.sender ? `GitHub · ${event.sender}` : 'GitHub' },
      {
        action: logAction,
        target: { type: 'pull_request', id },
        metadata: {
          number: pull.number,
          title: pull.title,
          branch: pull.headRef,
          login: pull.authorLogin,
          change: logAction === 'repo.pr.updated' ? event.action : undefined,
          sha: pull.mergeSha?.slice(0, 7),
        },
      },
    );
  };
  const values = {
    title: pull.title,
    description: pull.description,
    status: statusOf(pull.state),
    branch: pull.headRef,
    base: pull.base,
    head_sha: pull.headSha,
    html_url: pull.htmlUrl,
    github_state: pull.state,
    head_ref: pull.headRef,
    author_login: pull.authorLogin,
    merged_at: pull.mergedAt,
    merge_sha: pull.mergeSha,
  };
  const updated = await tx
    .updateTable('pull_requests')
    .set({ ...values, updated_at: sql<Date>`now()` })
    .where('project_id', '=', scope.projectId)
    .where('github_number', '=', pull.number)
    .returning('id')
    .executeTakeFirst();
  if (updated) {
    await record(updated.id);
    return;
  }
  // In-app numbers are per project: serialise like createPullRequest.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pr-number:${scope.projectId}`}, 0))`.execute(
    tx,
  );
  const { next } = await tx
    .selectFrom('pull_requests')
    .select(sql<number>`COALESCE(MAX(number), 0) + 1`.as('next'))
    .where('project_id', '=', scope.projectId)
    .executeTakeFirstOrThrow();
  const inserted = await tx
    .insertInto('pull_requests')
    .values({
      ...values,
      org_id: scope.orgId,
      project_id: scope.projectId,
      number: next,
      github_number: pull.number,
      author_user_id: null,
      author_kind: 'human',
    })
    .onConflict((oc) =>
      oc
        .columns(['project_id', 'github_number'])
        .doUpdateSet({ ...values, updated_at: sql<Date>`now()` }),
    )
    .returning('id')
    .executeTakeFirstOrThrow();
  await record(inserted.id);
}

/** ParallelFlow's own log commits (snapshot.ts): never an event, or every log update would log. */
const LOG_COMMIT = /^Update (progress|logs)\b/;
const SHA7 = /^[0-9a-f]{7,40}$/;

export interface PushFacts {
  branch: string;
  count: number;
  /** Short head sha. */
  head: string | null;
  /** First lines of up to 5 commits (newest last), cut to 80 characters. */
  subjects: string[];
  pusher: string | null;
}

/**
 * A push webhook as an activity event, or null: a deleted branch, a tag, or a push of only
 * ParallelFlow's own log commits.
 */
export function pushFacts(payload: Record<string, unknown>): PushFacts | null {
  const ref = typeof payload.ref === 'string' ? payload.ref : '';
  if (!ref.startsWith('refs/heads/') || payload.deleted === true) return null;
  const branch = ref.slice('refs/heads/'.length);
  if (!REF.test(branch)) return null;
  const commits = (Array.isArray(payload.commits) ? payload.commits : []) as {
    message?: unknown;
  }[];
  const messages = commits.map((c) => (typeof c.message === 'string' ? c.message : ''));
  const real = messages.filter((m) => !LOG_COMMIT.test(m));
  if (commits.length > 0 && real.length === 0) return null;
  const after =
    typeof payload.after === 'string' && SHA7.test(payload.after) ? payload.after : null;
  return {
    branch,
    count: real.length,
    head: after ? after.slice(0, 7) : null,
    subjects: real.slice(-5).map((m) => (m.split('\n')[0] ?? '').trim().slice(0, 80)),
    pusher: loginOf(payload.pusher) ?? loginOf(payload.sender),
  };
}
