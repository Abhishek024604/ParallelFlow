import type {
  BranchSummary,
  CodingEvent,
  CodingPushResult,
  CodingSession,
  CodingSessionStatus,
  CreateCodingSession,
  CreatePullRequest,
  CreateReview,
  PersonRef,
  PullRequestDetail,
  PullRequestStatus,
  PullRequestSummary,
  PullReview,
  ReviewDecision,
} from '@saras/contracts';
import { notify, type Tx } from '@saras/db';
import { sql } from 'kysely';
import { ARENA_POST, arenaIdOf, hasCapability, insertArenaCard } from '../arenas/messages.js';
import { ApiError, notFound } from '../pipeline/errors.js';
import { BundleError, MergeConflictError, type ArenaRepos } from '../repo/git.js';
import { buildProgressSnapshot } from '../repo/snapshot.js';
import {
  branchFor,
  isOpen,
  mergeBlocker,
  PR_MERGE,
  pushBranchError,
  reviewedStatus,
  reviewError,
  type ReviewFact,
} from './rules.js';

// AI coding sessions and pull requests (ADR-037). Every function runs in the pipeline's verified
// tenant transaction (@ProjectScoped, cookie or bearer): RLS keeps rows to the arena's org and the
// queries filter by the path's project. Git work goes through ArenaRepos (one queue per arena).
// Titles and descriptions are tenant content: never logged.

export interface CodeScope {
  projectId: string;
  orgId: string;
  userId: string;
}

const iso = (d: Date | string) => new Date(d).toISOString();

function forbidden(capability: string, detail: string): ApiError {
  return new ApiError(403, 'FORBIDDEN', { detail, requiredPermission: `cap ${capability}` });
}

async function person(tx: Tx, userId: string): Promise<{ name: string; email: string }> {
  const row = await tx
    .selectFrom('users')
    .select(['display_name', 'email'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return { name: row?.display_name ?? 'Former teammate', email: row?.email ?? 'noreply@saras.app' };
}

async function requireCap(tx: Tx, s: CodeScope, cap: string, detail: string): Promise<void> {
  if (!(await hasCapability(tx, s.projectId, s.userId, cap))) throw forbidden(cap, detail);
}

/** A card in the arena (top level, or a reply under `parentId`); null when the caller cannot post. */
async function post(
  tx: Tx,
  s: CodeScope,
  body: string,
  parentId: string | null = null,
): Promise<string | null> {
  if (!(await hasCapability(tx, s.projectId, s.userId, ARENA_POST))) return null;
  return insertArenaCard(tx, {
    orgId: s.orgId,
    arenaId: await arenaIdOf(tx, s.projectId),
    userId: s.userId,
    body,
    artifactRefs: [],
    parentId,
  });
}

/** Holders of pr.merge in the project (the Owner holds every capability). */
async function mergers(tx: Tx, projectId: string): Promise<string[]> {
  const rows = await tx
    .selectFrom('member_capabilities')
    .select('user_id')
    .where('project_id', '=', projectId)
    .where('capability', '=', PR_MERGE)
    .execute();
  return [...new Set(rows.flatMap((r) => (r.user_id ? [r.user_id] : [])))];
}

// ---------------------------------------------------------------- repo

/** main's head, creating the arena repo with its docs snapshot as the first commit if needed. */
export async function mainHead(tx: Tx, repos: ArenaRepos, projectId: string): Promise<string> {
  return repos.ensureHead(projectId, async () => ({
    ...(await buildProgressSnapshot(tx, projectId)),
    message: 'Start the arena repository',
  }));
}

// ---------------------------------------------------------------- coding sessions

interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  branch: string;
  base_sha: string;
  head_sha: string | null;
  status: string;
  started_by: string;
  message_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toSession(r: SessionRow): CodingSession {
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    description: r.description,
    branch: r.branch,
    base_sha: r.base_sha,
    head_sha: r.head_sha,
    status: r.status as CodingSessionStatus,
    started_by: r.started_by,
    message_id: r.message_id,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

const SESSION_COLUMNS = [
  'id',
  'project_id',
  'title',
  'description',
  'branch',
  'base_sha',
  'head_sha',
  'status',
  'started_by',
  'message_id',
  'created_at',
  'updated_at',
] as const;

/** The caller's own session in this project (others' sessions are 404 to the extension). */
async function ownSession(tx: Tx, s: CodeScope, sessionId: string): Promise<SessionRow> {
  const row = await tx
    .selectFrom('coding_sessions')
    .select(SESSION_COLUMNS)
    .where('id', '=', sessionId)
    .where('project_id', '=', s.projectId)
    .where('started_by', '=', s.userId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

export async function startCodingSession(
  tx: Tx,
  repos: ArenaRepos,
  s: CodeScope,
  input: CreateCodingSession,
): Promise<CodingSession> {
  await requireCap(tx, s, ARENA_POST, 'You cannot start AI coding tasks in this arena.');
  const baseSha = await mainHead(tx, repos, s.projectId);
  const me = await person(tx, s.userId);
  const messageId = await post(tx, s, `${me.name} started an AI coding task: ${input.title}`);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const row = await tx
        .insertInto('coding_sessions')
        .values({
          org_id: s.orgId,
          project_id: s.projectId,
          title: input.title,
          description: input.description,
          branch: branchFor(input.title),
          base_sha: baseSha,
          started_by: s.userId,
          message_id: messageId,
        })
        .returning(SESSION_COLUMNS)
        .executeTakeFirstOrThrow();
      return toSession(row);
    } catch (err) {
      // The 4-hex suffix collided with another session's branch: try another.
      if ((err as { code?: string }).code !== '23505' || attempt >= 3) throw err;
    }
  }
}

const EVENT_LABEL: Record<CodingEvent['kind'], string> = {
  progress: 'Progress',
  tests: 'Tests',
  blocked: 'Blocked',
  done: 'Done',
};

/** A compact update in the session's thread. `done` marks the session done. */
export async function addCodingEvent(
  tx: Tx,
  s: CodeScope,
  sessionId: string,
  event: CodingEvent,
): Promise<{ message_id: string | null }> {
  const session = await ownSession(tx, s, sessionId);
  const messageId = await post(
    tx,
    s,
    `${EVENT_LABEL[event.kind]}: ${event.summary}`,
    session.message_id,
  );
  if (event.kind === 'done' && session.status !== 'done') {
    await tx
      .updateTable('coding_sessions')
      .set({ status: 'done', updated_at: sql<Date>`now()` })
      .where('id', '=', session.id)
      .execute();
  }
  return { message_id: messageId };
}

/** Takes the session's branch from a pushed bundle; an open PR moves to the new head. */
export async function pushCodingSession(
  tx: Tx,
  repos: ArenaRepos,
  s: CodeScope,
  sessionId: string,
  bundle: unknown,
  requestedBranch: unknown,
): Promise<CodingPushResult> {
  const session = await ownSession(tx, s, sessionId);
  if (session.status === 'abandoned') {
    throw new ApiError(409, 'CONFLICT', { detail: 'This coding session was abandoned.' });
  }
  const branchError = pushBranchError(requestedBranch, session.branch);
  if (branchError) throw new ApiError(403, 'FORBIDDEN', { detail: branchError });
  if (!Buffer.isBuffer(bundle) || bundle.length === 0) {
    throw new ApiError(400, 'VALIDATION_FAILED', {
      detail: 'Send the git bundle as application/octet-stream.',
    });
  }
  let head: string;
  try {
    head = await repos.fetchBundle(s.projectId, session.branch, bundle);
  } catch (err) {
    if (err instanceof BundleError) {
      throw new ApiError(400, 'VALIDATION_FAILED', { detail: err.reason });
    }
    throw err;
  }
  await tx
    .updateTable('coding_sessions')
    .set({
      head_sha: head,
      status: session.status === 'done' ? 'done' : 'pushed',
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', session.id)
    .execute();

  const pr = await tx
    .selectFrom('pull_requests')
    .select(['id', 'number', 'status', 'head_sha', 'title'])
    .where('coding_session_id', '=', session.id)
    .where('status', 'in', ['open', 'approved', 'changes_requested'])
    .forUpdate()
    .executeTakeFirst();
  if (!pr) return { branch: session.branch, head_sha: head, pull_request: null };
  if (pr.head_sha === head) {
    return {
      branch: session.branch,
      head_sha: head,
      pull_request: { number: pr.number, status: pr.status as PullRequestStatus },
    };
  }
  // New commits: earlier approvals were for the old head, so the PR is open again.
  await tx
    .updateTable('pull_requests')
    .set({ head_sha: head, status: 'open', updated_at: sql<Date>`now()` })
    .where('id', '=', pr.id)
    .execute();
  await post(
    tx,
    s,
    `Updated pull request #${pr.number} with new commits (${head.slice(0, 7)})`,
    session.message_id,
  );
  await notify(tx, {
    orgId: s.orgId,
    projectId: s.projectId,
    type: 'approval_request',
    title: `Pull request #${pr.number} was updated: ${pr.title}`,
    resourceType: 'pull_request',
    resourceId: pr.id,
    deepLink: `/arena/${s.projectId}?pr=${pr.number}`,
    actor: { type: 'user', id: s.userId },
    requiresAction: true,
    dedupeKey: `pr:${pr.id}:head:${head}`,
    recipients: { userIds: await mergers(tx, s.projectId) },
  });
  return {
    branch: session.branch,
    head_sha: head,
    pull_request: { number: pr.number, status: 'open' },
  };
}

// ---------------------------------------------------------------- pull requests

interface PullRow {
  id: string;
  number: number;
  title: string;
  description: string;
  status: string;
  branch: string;
  head_sha: string;
  author_user_id: string;
  author_name: string | null;
  author_kind: string;
  coding_session_id: string | null;
  session_title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  merged_at: Date | string | null;
  merged_by: string | null;
  merged_by_name: string | null;
  merge_sha: string | null;
}

function ref(id: string, name: string | null): PersonRef {
  return { id, display_name: name ?? 'Former teammate' };
}

function toSummary(r: PullRow): PullRequestSummary {
  return {
    number: r.number,
    title: r.title,
    status: r.status as PullRequestStatus,
    branch: r.branch,
    head_sha: r.head_sha,
    author: ref(r.author_user_id, r.author_name),
    author_kind: r.author_kind === 'ai' ? 'ai' : 'human',
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    merged_at: r.merged_at ? iso(r.merged_at) : null,
  };
}

function pullQuery(tx: Tx, projectId: string) {
  return tx
    .selectFrom('pull_requests as p')
    .leftJoin('users as a', 'a.id', 'p.author_user_id')
    .leftJoin('users as m', 'm.id', 'p.merged_by')
    .leftJoin('coding_sessions as cs', 'cs.id', 'p.coding_session_id')
    .select([
      'p.id',
      'p.number',
      'p.title',
      'p.description',
      'p.status',
      'p.branch',
      'p.head_sha',
      'p.author_user_id',
      'a.display_name as author_name',
      'p.author_kind',
      'p.coding_session_id',
      'cs.title as session_title',
      'p.created_at',
      'p.updated_at',
      'p.merged_at',
      'p.merged_by',
      'm.display_name as merged_by_name',
      'p.merge_sha',
    ])
    .where('p.project_id', '=', projectId);
}

async function pullByNumber(tx: Tx, projectId: string, number: number, lock = false) {
  if (!Number.isInteger(number) || number < 1 || number > 1e9) throw notFound();
  let q = pullQuery(tx, projectId).where('p.number', '=', number);
  if (lock) q = q.forUpdate('p');
  const row = (await q.executeTakeFirst()) as PullRow | undefined;
  if (!row) throw notFound();
  return row;
}

export async function createPullRequest(
  tx: Tx,
  repos: ArenaRepos,
  s: CodeScope,
  input: CreatePullRequest,
): Promise<PullRequestSummary> {
  const session = await ownSession(tx, s, input.coding_session_id);
  if (!session.head_sha) {
    throw new ApiError(409, 'CONFLICT', {
      detail: 'Push the branch before opening a pull request.',
    });
  }
  if ((await repos.aheadOf(s.projectId, session.head_sha)) === 0) {
    throw new ApiError(409, 'CONFLICT', { detail: 'The branch has no commits that main lacks.' });
  }
  // Numbers are per project: serialise opening PRs in this project.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pr-number:${s.projectId}`}, 0))`.execute(
    tx,
  );
  const open = await tx
    .selectFrom('pull_requests')
    .select('number')
    .where('project_id', '=', s.projectId)
    .where('branch', '=', session.branch)
    .where('status', 'in', ['open', 'approved', 'changes_requested'])
    .executeTakeFirst();
  if (open) {
    throw new ApiError(409, 'CONFLICT', {
      detail: `Pull request #${open.number} is already open for this branch. Push to update it.`,
    });
  }
  const { next } = await tx
    .selectFrom('pull_requests')
    .select(sql<number>`COALESCE(MAX(number), 0) + 1`.as('next'))
    .where('project_id', '=', s.projectId)
    .executeTakeFirstOrThrow();
  const me = await person(tx, s.userId);
  const messageId = await post(
    tx,
    s,
    `${me.name} opened pull request #${next}: ${input.title} (written by AI, ${session.branch} → main)`,
  );
  const inserted = await tx
    .insertInto('pull_requests')
    .values({
      org_id: s.orgId,
      project_id: s.projectId,
      number: next,
      title: input.title,
      description: input.description,
      branch: session.branch,
      head_sha: session.head_sha,
      author_user_id: s.userId,
      author_kind: 'ai',
      coding_session_id: session.id,
      message_id: messageId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await notify(tx, {
    orgId: s.orgId,
    projectId: s.projectId,
    type: 'approval_request',
    title: `${me.name} opened pull request #${next}: ${input.title}`,
    preview: input.description,
    resourceType: 'pull_request',
    resourceId: inserted.id,
    deepLink: `/arena/${s.projectId}?pr=${next}`,
    actor: { type: 'user', id: s.userId },
    requiresAction: true,
    dedupeKey: `pr:${inserted.id}:opened`,
    recipients: { userIds: await mergers(tx, s.projectId) },
  });
  return toSummary(await pullByNumber(tx, s.projectId, next));
}

export async function listPullRequests(tx: Tx, projectId: string): Promise<PullRequestSummary[]> {
  const rows = (await pullQuery(tx, projectId)
    .orderBy('p.number', 'desc')
    .limit(100)
    .execute()) as PullRow[];
  return rows.map(toSummary);
}

export async function getPullSummary(
  tx: Tx,
  projectId: string,
  number: number,
): Promise<PullRequestSummary> {
  return toSummary(await pullByNumber(tx, projectId, number));
}

async function reviewsOf(tx: Tx, prId: string): Promise<PullReview[]> {
  const rows = await tx
    .selectFrom('pr_reviews as r')
    .leftJoin('users as u', 'u.id', 'r.reviewer_id')
    .select([
      'r.id',
      'r.reviewer_id',
      'u.display_name',
      'r.decision',
      'r.body',
      'r.head_sha',
      'r.created_at',
    ])
    .where('r.pr_id', '=', prId)
    .orderBy('r.created_at', 'asc')
    .limit(500)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    reviewer: ref(r.reviewer_id, r.display_name),
    decision: r.decision as ReviewDecision,
    body: r.body,
    head_sha: r.head_sha,
    created_at: iso(r.created_at),
  }));
}

function facts(reviews: readonly PullReview[]): ReviewFact[] {
  return reviews.map((r) => ({
    reviewerId: r.reviewer.id,
    decision: r.decision,
    headSha: r.head_sha,
    at: Date.parse(r.created_at),
  }));
}

export async function getPullRequest(
  tx: Tx,
  repos: ArenaRepos,
  s: CodeScope,
  number: number,
): Promise<PullRequestDetail> {
  const row = await pullByNumber(tx, s.projectId, number);
  const reviews = await reviewsOf(tx, row.id);
  const canMerge = await hasCapability(tx, s.projectId, s.userId, PR_MERGE);
  const canPost = await hasCapability(tx, s.projectId, s.userId, ARENA_POST);
  const pr = {
    status: row.status as PullRequestStatus,
    authorId: row.author_user_id,
    headSha: row.head_sha,
  };
  // A merged PR shows what it brought in: its head against main's first parent at the merge.
  const diff = await repos.pullDiff(
    s.projectId,
    row.head_sha,
    row.merge_sha ? `${row.merge_sha}^1` : undefined,
  );
  const blocker = mergeBlocker(pr, facts(reviews));
  const isAuthor = row.author_user_id === s.userId;
  return {
    ...toSummary(row),
    description: row.description,
    base: 'main',
    merged_by: row.merged_by ? ref(row.merged_by, row.merged_by_name) : null,
    merge_sha: row.merge_sha,
    coding_session:
      row.coding_session_id && row.session_title
        ? { id: row.coding_session_id, title: row.session_title }
        : null,
    commits: diff.commits,
    files: diff.files,
    diff_truncated: diff.truncated,
    reviews,
    viewer: {
      is_author: isAuthor,
      can_review: isOpen(pr.status) && canPost,
      can_approve: isOpen(pr.status) && canMerge && !isAuthor,
      can_merge: canMerge && blocker === null,
      can_close: isOpen(pr.status) && (canMerge || isAuthor),
    },
    merge_blocker: blocker,
  };
}

export async function reviewPullRequest(
  tx: Tx,
  s: CodeScope,
  number: number,
  input: CreateReview,
): Promise<PullReview> {
  const row = await pullByNumber(tx, s.projectId, number, true);
  const pr = {
    status: row.status as PullRequestStatus,
    authorId: row.author_user_id,
    headSha: row.head_sha,
  };
  await requireCap(tx, s, ARENA_POST, 'You cannot review pull requests in this arena.');
  const canMerge = await hasCapability(tx, s.projectId, s.userId, PR_MERGE);
  const error = reviewError(pr, s.userId, input.decision, canMerge);
  if (error) {
    throw new ApiError(
      isOpen(pr.status) ? 403 : 409,
      isOpen(pr.status) ? 'FORBIDDEN' : 'CONFLICT',
      {
        detail: error,
        ...(isOpen(pr.status) && !canMerge && { requiredPermission: `cap ${PR_MERGE}` }),
      },
    );
  }
  const inserted = await tx
    .insertInto('pr_reviews')
    .values({
      org_id: s.orgId,
      pr_id: row.id,
      reviewer_id: s.userId,
      decision: input.decision,
      body: input.body,
      head_sha: row.head_sha,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const reviews = await reviewsOf(tx, row.id);
  const status = reviewedStatus(pr, facts(reviews));
  if (status !== pr.status) {
    await tx
      .updateTable('pull_requests')
      .set({ status, updated_at: sql<Date>`now()` })
      .where('id', '=', row.id)
      .execute();
  }
  const me = await person(tx, s.userId);
  const verb =
    input.decision === 'approve'
      ? 'approved'
      : input.decision === 'request_changes'
        ? 'requested changes on'
        : 'commented on';
  await notify(tx, {
    orgId: s.orgId,
    projectId: s.projectId,
    type: 'stage_update',
    title: `${me.name} ${verb} pull request #${row.number}: ${row.title}`,
    preview: input.body,
    resourceType: 'pull_request',
    resourceId: row.id,
    deepLink: `/arena/${s.projectId}?pr=${row.number}`,
    actor: { type: 'user', id: s.userId },
    requiresAction: input.decision === 'request_changes',
    dedupeKey: `pr-review:${inserted.id}`,
    recipients: { userIds: [row.author_user_id] },
  });
  const review = reviews.find((r) => r.id === inserted.id);
  if (!review) throw new Error('Review is not readable');
  return review;
}

export async function mergePullRequest(
  tx: Tx,
  repos: ArenaRepos,
  s: CodeScope,
  number: number,
): Promise<PullRequestSummary> {
  await requireCap(tx, s, PR_MERGE, 'Only teammates who can merge pull requests can merge them.');
  const row = await pullByNumber(tx, s.projectId, number, true);
  const pr = {
    status: row.status as PullRequestStatus,
    authorId: row.author_user_id,
    headSha: row.head_sha,
  };
  const blocker = mergeBlocker(pr, facts(await reviewsOf(tx, row.id)));
  if (blocker) throw new ApiError(409, 'PRECONDITION_FAILED', { detail: blocker });
  const me = await person(tx, s.userId);
  let mergeSha: string;
  try {
    mergeSha = await repos.merge(s.projectId, {
      sha: row.head_sha,
      message: `Merge PR #${row.number}: ${row.title}`,
      author: { name: me.name, email: me.email },
    });
  } catch (err) {
    if (err instanceof MergeConflictError) {
      throw new ApiError(409, 'CONFLICT', {
        detail: 'This branch conflicts with main. Ask the AI to rebase it on main and push again.',
      });
    }
    throw err;
  }
  await tx
    .updateTable('pull_requests')
    .set({
      status: 'merged',
      merged_at: sql<Date>`now()`,
      merged_by: s.userId,
      merge_sha: mergeSha,
      updated_at: sql<Date>`now()`,
    })
    .where('id', '=', row.id)
    .execute();
  if (row.coding_session_id) {
    await tx
      .updateTable('coding_sessions')
      .set({ status: 'done', updated_at: sql<Date>`now()` })
      .where('id', '=', row.coding_session_id)
      .execute();
  }
  await post(tx, s, `${me.name} merged pull request #${row.number} into main: ${row.title}`);
  await notify(tx, {
    orgId: s.orgId,
    projectId: s.projectId,
    type: 'stage_update',
    title: `${me.name} merged pull request #${row.number}: ${row.title}`,
    resourceType: 'pull_request',
    resourceId: row.id,
    deepLink: `/arena/${s.projectId}?pr=${row.number}`,
    actor: { type: 'user', id: s.userId },
    dedupeKey: `pr:${row.id}:merged`,
    recipients: { members: true },
  });
  return toSummary(await pullByNumber(tx, s.projectId, number));
}

export async function closePullRequest(
  tx: Tx,
  s: CodeScope,
  number: number,
): Promise<PullRequestSummary> {
  const row = await pullByNumber(tx, s.projectId, number, true);
  if (!isOpen(row.status as PullRequestStatus)) {
    throw new ApiError(409, 'CONFLICT', { detail: 'This pull request is already closed.' });
  }
  const canMerge = await hasCapability(tx, s.projectId, s.userId, PR_MERGE);
  if (!canMerge && row.author_user_id !== s.userId) {
    throw forbidden(PR_MERGE, 'Only its author or a teammate who can merge can close it.');
  }
  await tx
    .updateTable('pull_requests')
    .set({ status: 'closed', updated_at: sql<Date>`now()` })
    .where('id', '=', row.id)
    .execute();
  return toSummary(await pullByNumber(tx, s.projectId, number));
}

export async function listBranches(
  tx: Tx,
  repos: ArenaRepos,
  projectId: string,
): Promise<BranchSummary[]> {
  const [branches, prs] = await Promise.all([
    repos.branches(projectId),
    tx
      .selectFrom('pull_requests')
      .select(['branch', 'number', 'status'])
      .where('project_id', '=', projectId)
      .orderBy('number', 'desc')
      .execute(),
  ]);
  return branches.map((b) => {
    const pr = prs.find((p) => p.branch === b.name);
    return {
      name: b.name,
      head_sha: b.sha,
      updated_at: b.at,
      ahead: b.ahead,
      pull_request: pr ? { number: pr.number, status: pr.status as PullRequestStatus } : null,
    };
  });
}
