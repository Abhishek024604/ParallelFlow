import { createHash } from 'node:crypto';
import {
  GITHUB_ERROR_PARAM,
  GITHUB_GRANT_PARAM,
  type GithubConnectError,
  type GithubConnectRepo,
  type GithubRepoChoice,
  type GithubRepoLink,
  type GithubStatus,
} from '@parallelflow/contracts';
import { type Database, recordArenaEvent, type Tx } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import { sql } from 'kysely';
import { isArenaOwner } from '../arenas/arena-admin.js';
import { ApiError } from '../pipeline/errors.js';
import type { Clock } from '../pipeline/tokens.js';
import type { ArenaRepos, RemoteLink, RepoScope } from '../repo/git.js';
import { buildProgressSnapshot } from '../repo/snapshot.js';
import {
  type GithubAppConfig,
  GithubApiError,
  GithubClient,
  SignedValues,
  verifyWebhookSignature,
} from './github-app.js';
import { githubPullFrom, loginOf, pushFacts, upsertGithubPull } from './pulls.js';

// Connecting an arena to a GitHub repository and keeping the two in step (ADR-040).
//
// Connect (arena owner):
//   1. POST …/github/connect signs a `state` (person, arena, 15 min) and sends the browser to the
//      app's install page on GitHub, where the owner picks an account and repositories.
//   2. GitHub returns to the Setup URL (GET /github/setup?installation_id&state). An installation
//      id in a URL proves nothing, so the browser goes on to GitHub sign-in for the app (OAuth),
//      with a new state that carries the installation.
//   3. GitHub returns to the Callback URL (GET /github/callback?code&state). The person's GitHub
//      token (used once, then dropped) lists the repositories of that installation they can
//      access; the arena page gets a signed grant naming them (15 min).
//   4. The owner picks one (GET …/github/choices, POST …/github/repo); the row is saved, and once
//      it commits the arena repo syncs with GitHub (git.ts connect).
// Sync: every gate approval and merge goes through git.ts with the arena's RemoteLink; webhooks
// (push, merged pull_request) fast-forward the arena repo; installation events record an error.
// pull_request events also mirror the pull request into the arena's list (pulls.ts, ADR-042).
// Webhooks are verified (X-Hub-Signature-256), each delivery id is processed once
// (github_webhook_deliveries), and the work runs after the 202 (in process, SLICE_DEBT).
// Tokens, codes and payload contents are never logged; ids only.

const STATE_TTL_MS = 15 * 60_000;
const MAX_GRANT_REPOS = 100;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const DELIVERY = /^[A-Za-z0-9-]{1,100}$/;
const EVENT = /^[a-z_]{1,60}$/;

const UNINSTALLED =
  'The ParallelFlow app was removed from this GitHub account or repository. Connect GitHub again.';
const SUSPENDED = 'The ParallelFlow app is suspended on GitHub. Unsuspend it to sync again.';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

interface RepoRow {
  org_id: string;
  project_id: string;
  installation_id: string;
  repo_id: string;
  owner: string;
  name: string;
  default_branch: string;
  connected_at: Date;
  last_synced_at: Date | null;
  last_sync_error: string | null;
}

function link(row: RepoRow): GithubRepoLink {
  const fullName = `${row.owner}/${row.name}`;
  return {
    owner: row.owner,
    name: row.name,
    full_name: fullName,
    html_url: `https://github.com/${fullName}`,
    clone_url: `https://github.com/${fullName}.git`,
    default_branch: row.default_branch,
    connected_at: new Date(row.connected_at).toISOString(),
    last_synced_at: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    last_sync_error: row.last_sync_error,
  };
}

const OFF = () =>
  new ApiError(409, 'PRECONDITION_FAILED', {
    detail: 'GitHub is not set up on this server yet.',
  });
const EXPIRED = () =>
  new ApiError(409, 'PRECONDITION_FAILED', {
    detail: 'This GitHub sign-in has expired. Press Connect GitHub again.',
  });

export interface GithubDeps {
  db: Database;
  repos: ArenaRepos;
  logger: Logger;
  clock: Clock;
  webOrigin: string;
  /** HMAC key of `state` and grants. */
  stateKey: Buffer;
  /** Unset = GitHub is off: status says so and every other route answers 409. */
  config?: GithubAppConfig;
  /** Tests: a GitHub client with a fake fetch. */
  client?: GithubClient;
}

export class GithubService {
  readonly client: GithubClient | null;
  private readonly signed: SignedValues;

  constructor(private readonly deps: GithubDeps) {
    this.client = deps.client ?? (deps.config ? new GithubClient(deps.config, deps.clock) : null);
    this.signed = new SignedValues(deps.stateKey, deps.clock);
    if (this.client) {
      deps.repos.useRemotes({
        resolve: (scope) => this.remote(scope),
        report: (scope, error) => void this.report(scope, error),
      });
    }
  }

  private gh(): GithubClient {
    if (!this.client) throw OFF();
    return this.client;
  }

  private async row(tx: Tx, projectId: string): Promise<RepoRow | undefined> {
    return tx
      .selectFrom('arena_github_repos')
      .selectAll()
      .where('project_id', '=', projectId)
      .executeTakeFirst() as Promise<RepoRow | undefined>;
  }

  /** The repository link for GET …/repo (`remote`), or null. */
  async htmlUrl(tx: Tx, projectId: string): Promise<string | null> {
    const row = await this.row(tx, projectId);
    return row ? link(row).html_url : null;
  }

  async status(tx: Tx, projectId: string, userId: string): Promise<GithubStatus> {
    const [row, owner] = await Promise.all([
      this.row(tx, projectId),
      isArenaOwner(tx, projectId, userId),
    ]);
    return {
      available: this.client !== null,
      can_manage: owner,
      repo: row ? link(row) : null,
    };
  }

  // ---------------------------------------------------------------- connect

  /** Step 1: the install page on GitHub, with a state bound to the person and the arena. */
  startUrl(projectId: string, userId: string): string {
    const gh = this.gh();
    return gh.installUrl(this.signed.sign('install', { p: projectId, u: userId }, STATE_TTL_MS));
  }

  private arenaUrl(projectId: string | null, params: Record<string, string>): string {
    const url = new URL(projectId ? `/arena/${projectId}` : '/', this.deps.webOrigin);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private failUrl(projectId: string | null, reason: GithubConnectError): string {
    return this.arenaUrl(projectId, { [GITHUB_ERROR_PARAM]: reason });
  }

  /** Step 2: GitHub's Setup URL → GitHub sign-in for the app, carrying the installation. */
  setupRedirect(query: Record<string, unknown>, userId: string): string {
    const gh = this.gh();
    const state = this.signed.verify('install', query.state);
    const projectId = typeof state?.p === 'string' ? state.p : null;
    if (!state || !projectId || state.u !== userId) return this.failUrl(projectId, 'expired');
    const installation = Number(query.installation_id);
    if (!Number.isSafeInteger(installation) || installation <= 0) {
      return this.failUrl(projectId, 'denied');
    }
    return gh.authorizeUrl(
      this.signed.sign('oauth', { p: projectId, u: userId, i: installation }, STATE_TTL_MS),
    );
  }

  /** Step 3: GitHub's Callback URL → the arena page with a grant of the person's repositories. */
  async callbackRedirect(query: Record<string, unknown>, userId: string): Promise<string> {
    const gh = this.gh();
    const state = this.signed.verify('oauth', query.state);
    const projectId = typeof state?.p === 'string' ? state.p : null;
    if (!state || !projectId || state.u !== userId) return this.failUrl(projectId, 'expired');
    const installation = state.i as number;
    if (query.error !== undefined || typeof query.code !== 'string' || query.code.length > 200) {
      return this.failUrl(projectId, 'denied');
    }
    let repoIds: number[];
    try {
      const token = await gh.userToken(query.code);
      repoIds = await gh.userInstallationRepos(token, installation);
    } catch (err) {
      const status = err instanceof GithubApiError ? err.status : 0;
      this.deps.logger.warn({ projectId, status }, 'github: sign-in check failed');
      return this.failUrl(projectId, status === 403 || status === 404 ? 'no_access' : 'failed');
    }
    if (repoIds.length === 0) return this.failUrl(projectId, 'no_repos');
    const grant = this.signed.sign(
      'grant',
      { p: projectId, u: userId, i: installation, r: repoIds.slice(0, MAX_GRANT_REPOS) },
      STATE_TTL_MS,
    );
    return this.arenaUrl(projectId, { [GITHUB_GRANT_PARAM]: grant });
  }

  private grant(value: unknown, projectId: string, userId: string) {
    const g = this.signed.verify('grant', value);
    if (!g || g.p !== projectId || g.u !== userId || !Array.isArray(g.r)) throw EXPIRED();
    return { installation: g.i as number, repoIds: g.r as number[] };
  }

  /** Step 4a: the granted repositories, with names, for the picker. */
  async choices(projectId: string, userId: string, grant: unknown): Promise<GithubRepoChoice[]> {
    const gh = this.gh();
    const { installation, repoIds } = this.grant(grant, projectId, userId);
    const allowed = new Set(repoIds);
    let repos;
    try {
      repos = await gh.installationRepos(installation);
    } catch {
      throw new ApiError(409, 'PRECONDITION_FAILED', {
        detail: 'GitHub could not be reached. Try again in a moment.',
      });
    }
    return repos
      .filter((r) => allowed.has(r.id))
      .map((r) => ({
        id: r.id,
        full_name: r.full_name,
        private: r.private,
        default_branch: r.default_branch,
      }));
  }

  /**
   * Step 4b: saves the arena's repository in `tx` and returns the first sync to start after the
   * commit (the arena's docs on top of GitHub's default branch).
   */
  async connect(
    tx: Tx,
    scope: RepoScope,
    userId: string,
    body: GithubConnectRepo,
  ): Promise<{ status: GithubStatus; afterCommit: () => void }> {
    const gh = this.gh();
    const { installation, repoIds } = this.grant(body.grant, scope.projectId, userId);
    if (!repoIds.includes(body.repo_id)) throw EXPIRED();
    let info;
    try {
      info = await gh.repo(installation, body.repo_id);
    } catch {
      throw new ApiError(409, 'PRECONDITION_FAILED', {
        detail:
          'ParallelFlow cannot open this repository on GitHub. Check the app has access to it.',
      });
    }
    if (!OWNER.test(info.owner) || !NAME.test(info.name) || !BRANCH.test(info.default_branch)) {
      throw new ApiError(409, 'PRECONDITION_FAILED', {
        detail: 'This repository name or default branch is not supported.',
      });
    }
    const values = {
      org_id: scope.orgId,
      project_id: scope.projectId,
      installation_id: String(installation),
      repo_id: String(info.id),
      owner: info.owner,
      name: info.name,
      default_branch: info.default_branch,
      connected_by: userId,
    };
    await tx
      .insertInto('arena_github_repos')
      .values(values)
      .onConflict((oc) =>
        oc.column('project_id').doUpdateSet({
          installation_id: values.installation_id,
          repo_id: values.repo_id,
          owner: values.owner,
          name: values.name,
          default_branch: values.default_branch,
          connected_by: userId,
          connected_at: sql<Date>`now()`,
          last_synced_at: null,
          last_sync_error: null,
        }),
      )
      .execute();
    await recordArenaEvent(
      tx,
      { orgId: scope.orgId, projectId: scope.projectId },
      { type: 'user', id: userId },
      {
        action: 'repo.connected',
        target: { type: 'repository', id: String(info.id) },
        metadata: { repo: `${info.owner}/${info.name}`, branch: info.default_branch },
      },
    );
    const me = await tx
      .selectFrom('users')
      .select(['display_name', 'email'])
      .where('id', '=', userId)
      .executeTakeFirst();
    const snapshot = {
      ...(await buildProgressSnapshot(tx, scope.projectId)),
      author: {
        name: me?.display_name ?? 'A teammate',
        email: me?.email ?? 'noreply@parallelflow.app',
      },
      message: `Connect GitHub · ${info.owner}/${info.name}`,
    };
    this.deps.logger.info(
      { projectId: scope.projectId, installation, repoId: info.id },
      'github: arena connected',
    );
    return {
      status: await this.status(tx, scope.projectId, userId),
      afterCommit: () => void this.deps.repos.connect(scope, snapshot),
    };
  }

  /** Forgets the repository (GitHub and the app installation are not changed). */
  async disconnect(tx: Tx, projectId: string, userId?: string): Promise<() => void> {
    const gone = await tx
      .deleteFrom('arena_github_repos')
      .where('project_id', '=', projectId)
      .returning(['org_id', 'owner', 'name', 'repo_id'])
      .executeTakeFirst();
    if (gone && userId) {
      await recordArenaEvent(
        tx,
        { orgId: gone.org_id, projectId },
        { type: 'user', id: userId },
        {
          action: 'repo.disconnected',
          target: { type: 'repository', id: String(gone.repo_id) },
          metadata: { repo: `${gone.owner}/${gone.name}` },
        },
      );
    }
    return () => void this.deps.repos.disconnect(projectId);
  }

  /** "Sync now": the arena repo follows GitHub (or pushes what GitHub is missing). */
  syncNow(scope: RepoScope): void {
    this.gh();
    void this.deps.repos.pull(scope);
  }

  // ---------------------------------------------------------------- git.ts hooks

  private async remote(scope: RepoScope): Promise<RemoteLink | null> {
    const gh = this.client;
    if (!gh) return null;
    const row = await this.deps.db.withSystemJob({ orgId: scope.orgId }, (tx) =>
      this.row(tx, scope.projectId),
    );
    if (!row || row.org_id !== scope.orgId || !BRANCH.test(row.default_branch)) return null;
    const installation = Number(row.installation_id);
    const repoId = Number(row.repo_id);
    return {
      url: `https://github.com/${row.owner}/${row.name}.git`,
      branch: row.default_branch,
      token: () => gh.tokens.get(installation, repoId),
    };
  }

  private async report(scope: RepoScope, error: string | null): Promise<void> {
    try {
      await this.deps.db.withSystemJob({ orgId: scope.orgId }, (tx) =>
        tx
          .updateTable('arena_github_repos')
          .set(
            error === null
              ? { last_synced_at: sql<Date>`now()`, last_sync_error: null }
              : { last_sync_error: error.slice(0, 500) },
          )
          .where('project_id', '=', scope.projectId)
          .execute(),
      );
    } catch (err) {
      this.deps.logger.warn(
        { projectId: scope.projectId, err: err instanceof Error ? err.name : 'Error' },
        'github: sync status not saved',
      );
    }
  }

  // ---------------------------------------------------------------- webhooks

  /**
   * POST /github/webhook. Returns the status to answer at once: 401 bad signature, 400 bad
   * headers, 202 accepted (the work runs afterwards), 200 a delivery seen before.
   */
  async webhook(headers: Record<string, unknown>, body: Buffer): Promise<number> {
    const config = this.deps.config ?? this.client?.config;
    if (!config) return 404;
    const signature = headers['x-hub-signature-256'];
    const given = typeof signature === 'string' ? signature : undefined;
    if (!verifyWebhookSignature(config.webhookSecret, body, given)) {
      return 401;
    }
    const delivery = headers['x-github-delivery'];
    const event = headers['x-github-event'];
    if (typeof delivery !== 'string' || !DELIVERY.test(delivery)) return 400;
    if (typeof event !== 'string' || !EVENT.test(event)) return 400;
    const fresh = await this.deps.db.withCredential({ credential: sha256(delivery) }, (tx) =>
      tx
        .insertInto('github_webhook_deliveries')
        .values({ delivery_id: delivery, event })
        .onConflict((oc) => oc.column('delivery_id').doNothing())
        .returning('delivery_id')
        .executeTakeFirst(),
    );
    if (!fresh) return 200;
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      return 400;
    }
    setImmediate(() => {
      this.handle(event, payload).catch((err: unknown) =>
        this.deps.logger.warn(
          { event, err: err instanceof Error ? err.name : 'Error' },
          'github: webhook failed',
        ),
      );
    });
    return 202;
  }

  /** The arenas connected to a repository or an installation (credential scope, read only). */
  private async arenas(key: string): Promise<RepoRow[]> {
    return this.deps.db.withCredential({ credential: sha256(key) }, (tx) =>
      tx.selectFrom('arena_github_repos').selectAll().execute(),
    ) as Promise<RepoRow[]>;
  }

  /** Upserts a GitHub pull request into each arena connected to its repository. */
  private async mirrorPull(repoId: number, payload: Record<string, unknown>): Promise<void> {
    const pull = githubPullFrom(payload);
    if (!pull) return;
    for (const row of await this.arenas(`github-repo:${repoId}`)) {
      const scope = { orgId: row.org_id, projectId: row.project_id };
      await this.deps.db.withSystemJob({ orgId: row.org_id }, (tx) =>
        upsertGithubPull(tx, scope, pull, {
          action: String(payload.action),
          sender: loginOf(payload.sender),
        }),
      );
      this.deps.logger.info(
        { projectId: row.project_id, number: pull.number, state: pull.state },
        'github: pull request mirrored',
      );
    }
  }

  private async handle(event: string, payload: unknown): Promise<void> {
    const p = (payload ?? {}) as Record<string, unknown>;
    const repo = p.repository as { id?: unknown } | undefined;
    const installation = p.installation as { id?: unknown } | undefined;
    const scopeOf = (r: RepoRow) => ({ orgId: r.org_id, projectId: r.project_id });

    if (event === 'push' || event === 'pull_request') {
      if (typeof repo?.id !== 'number') return;
      if (event === 'pull_request') await this.mirrorPull(repo.id, p);
      const pr = p.pull_request as { merged?: unknown; base?: { ref?: unknown } } | undefined;
      const ref =
        event === 'push'
          ? p.ref
          : p.action === 'closed' && pr?.merged === true
            ? `refs/heads/${String(pr.base?.ref)}`
            : null;
      if (typeof ref !== 'string') return;
      const push = event === 'push' ? pushFacts(p) : null;
      for (const row of await this.arenas(`github-repo:${repo.id}`)) {
        if (push) {
          await this.deps.db.withSystemJob({ orgId: row.org_id }, (tx) =>
            recordArenaEvent(
              tx,
              scopeOf(row),
              { type: 'service', label: push.pusher ? `GitHub · ${push.pusher}` : 'GitHub' },
              {
                action: 'repo.commit.pushed',
                target: { type: 'branch', id: push.branch },
                metadata: {
                  branch: push.branch,
                  count: push.count,
                  sha: push.head,
                  commits: push.subjects,
                  default_branch: push.branch === row.default_branch,
                },
              },
            ),
          );
        }
        if (ref === `refs/heads/${row.default_branch}`) {
          await this.deps.repos.pull(scopeOf(row));
        }
      }
      return;
    }
    if (typeof installation?.id !== 'number') return;
    const installationId = installation.id;
    if (event === 'installation') {
      const action = p.action;
      if (action === 'deleted' || action === 'suspend') {
        this.client?.tokens.forget(installationId);
        const error = action === 'deleted' ? UNINSTALLED : SUSPENDED;
        for (const row of await this.arenas(`github-installation:${installationId}`)) {
          await this.report(scopeOf(row), error);
        }
      } else if (action === 'unsuspend') {
        for (const row of await this.arenas(`github-installation:${installationId}`)) {
          await this.deps.repos.pull(scopeOf(row));
        }
      }
      return;
    }
    if (event === 'installation_repositories') {
      const removed = Array.isArray(p.repositories_removed) ? p.repositories_removed : [];
      for (const r of removed as { id?: unknown }[]) {
        if (typeof r.id !== 'number') continue;
        for (const row of await this.arenas(`github-repo:${r.id}`)) {
          if (Number(row.installation_id) === installationId) {
            await this.report(scopeOf(row), UNINSTALLED);
          }
        }
      }
    }
  }
}
