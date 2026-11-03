import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '@parallelflow/observability';

// One git repository per arena. Every approved gate writes the arena's approved state (snapshot.ts)
// into the repo's working tree and commits it as the approver, so the arena's history is a plain git
// log anyone can clone and read. The snapshot owns only README.md, PROGRESS.md, STATE.md, AGENTS.md
// and the docs/ stage folders (isManagedPath); code reaches main only through reviewed pull
// requests (ADR-037), and a snapshot never removes it. The working tree is always main, clean after
// each queued step.
//
// GitHub (ADR-040): once an arena is connected, its GitHub repository is `origin` and is canonical.
// Every write (a snapshot, a merge) fetches origin, puts local main at origin's default branch,
// commits on top and pushes, never with force; a rejected push (someone pushed meanwhile) is
// fetched and retried a few times. A push or merge on GitHub (webhook) fast-forwards local main, so
// the Overview shows GitHub's history. The installation token reaches git only through the
// environment (GIT_CONFIG_COUNT: an http.extraHeader for https://github.com/), never in argv, the
// remote URL or .git/config.
//
// Safety: git runs with execFile and an argument list (never a shell); paths come from
// snapshot.ts's sanitiser and are checked to stay inside the repo; each arena's work runs one at a
// time (a per-arena queue). The repo is app data: hooks, signing and the user's global config do
// not apply (GIT_CONFIG_GLOBAL / NOSYSTEM). Contents, messages and tokens are never logged.

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OUTPUT = 20 * 1024 * 1024;
/** Largest repo bundle sent to the extension. */
const MAX_BUNDLE = 200 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
/** Pushes tried when GitHub keeps moving (each after a fresh fetch). */
const PUSH_ATTEMPTS = 3;
/** Where local main was before it first followed GitHub (kept, never pushed). */
const BEFORE_GITHUB_REF = 'refs/parallelflow/before-github';

/** The docs/ folders the snapshot owns: one per stage, and the PM's product documents. */
// docs/progress: the activity log's monthly archives and legacy.md (ADR-044).
const MANAGED_DOCS = new Set([
  'plan',
  'product',
  'design',
  'build',
  'test',
  'deploy',
  'maintain',
  'progress',
  // docs/state: the memory's graph.json and the pre-memory STATE.md (ADR-045).
  'state',
]);

/**
 * Entries the docs snapshot owns (and may replace): root files, legacy cycle-* folders and the
 * docs/ stage folders (`docs/<folder>`). Everything else is code from PRs, AGENTS.local.md
 * included, and is never touched.
 */
export function isManagedPath(entry: string): boolean {
  if (entry.startsWith('docs/')) return MANAGED_DOCS.has(entry.slice('docs/'.length));
  return (
    entry === 'README.md' ||
    entry === 'PROGRESS.md' ||
    entry === 'STATE.md' ||
    entry === 'AGENTS.md' ||
    // The logs' names before 24 Oct, so the next snapshot replaces them with the uppercase ones.
    entry === 'progress.md' ||
    entry === 'state.md' ||
    // The layout before ADR-040 (cycle-<n>/<stage>/), removed by the next snapshot.
    /^cycle-\d+$/.test(entry)
  );
}

/** The arena's GitHub repository, as git.ts needs it (ADR-040). */
export interface RemoteLink {
  /** https://github.com/<owner>/<name>.git, without credentials. */
  url: string;
  /** The remote's default branch; local main follows it. */
  branch: string;
  /** A short-lived installation token, minted on demand. Never stored or logged. */
  token: () => Promise<string>;
}

export interface RepoScope {
  orgId: string;
  projectId: string;
}

/** Remote lookup and outcome reporting (the GitHub module). */
export interface RemoteHooks {
  /** The arena's remote, or null when it is kept on the server only. */
  resolve: (scope: RepoScope) => Promise<RemoteLink | null>;
  /** How a sync went: null when the arena repo and GitHub match, else plain words. */
  report: (scope: RepoScope, error: string | null) => void;
}

/** A sync with GitHub failed; `reason` is plain words for the arena owner (no secrets). */
export class RemoteSyncError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RemoteSyncError';
  }
}

const UNREACHABLE =
  'GitHub could not be reached, or the ParallelFlow app has no access to this repository.';
const REFUSED =
  'GitHub refused the push. Check that the ParallelFlow app may write to this repository and that its default branch is not protected against it.';
const BUSY =
  'GitHub kept changing while ParallelFlow pushed. It is tried again at the next change.';
const FAILED = 'The arena repository could not be synced with GitHub.';

export function syncReason(err: unknown): string {
  return err instanceof RemoteSyncError ? err.reason : FAILED;
}

/**
 * Git environment that sends the installation token to github.com only (http.<origin>.extraHeader),
 * without a credential helper. The token never appears in argv, the URL or .git/config.
 */
export function remoteAuthEnv(url: string, token: string): Record<string, string> {
  const origin = `${new URL(url).origin}/`;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${origin}.extraHeader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}

/** A merge that git could not finish (conflicts); main is left as it was. */
export class MergeConflictError extends Error {
  constructor() {
    super('Merge conflict');
    this.name = 'MergeConflictError';
  }
}

/** The bundle does not carry the expected branch, or git refused it. */
export class BundleError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'BundleError';
  }
}

export interface BranchInfo {
  name: string;
  sha: string;
  at: string;
  ahead: number;
}

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  patch: string | null;
  truncated: boolean;
}

export interface PullDiff {
  commits: RepoCommit[];
  files: DiffFile[];
  truncated: boolean;
}

/** Caps of the PR view: the whole diff, one file's patch, commits and files listed. */
export const DIFF_LIMITS = { total: 1024 * 1024, file: 200 * 1024, commits: 100, files: 300 };

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};
const PARALLELFLOW_COMMITTER = {
  GIT_COMMITTER_NAME: 'ParallelFlow',
  GIT_COMMITTER_EMAIL: 'noreply@parallelflow.app',
};

/** Splits git's numstat, name-status (both -z) and unified diff into files, within DIFF_LIMITS. */
export function parseDiff(numstat: string, status: string, patch: string): PullDiff {
  const stats: { path: string; additions: number; deletions: number; binary: boolean }[] = [];
  for (const entry of numstat.split('\0')) {
    if (!entry) continue;
    const [add = '', del = '', path = ''] = entry.split('\t');
    stats.push({
      path,
      additions: Number(add) || 0,
      deletions: Number(del) || 0,
      binary: add === '-',
    });
  }
  const statusOf = new Map<string, string>();
  const parts = status.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i] ?? '';
    if (code) statusOf.set(parts[i + 1] ?? '', code.charAt(0));
  }
  // Same order as numstat: one chunk per file.
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  let budget = DIFF_LIMITS.total;
  let truncated = stats.length > DIFF_LIMITS.files;
  const files = stats.slice(0, DIFF_LIMITS.files).map((s, i): DiffFile => {
    const code = statusOf.get(s.path);
    const chunk = chunks[i] ?? '';
    const fits = chunk.length <= DIFF_LIMITS.file && chunk.length <= budget;
    if (fits) budget -= chunk.length;
    else if (!s.binary) truncated = true;
    return {
      path: s.path,
      status: code === 'A' ? 'added' : code === 'D' ? 'deleted' : 'modified',
      additions: s.additions,
      deletions: s.deletions,
      patch: s.binary || !fits ? null : chunk,
      truncated: !s.binary && !fits,
    };
  });
  return { commits: [], files, truncated };
}

export interface SnapshotFile {
  /** Repo-relative, forward slashes. */
  path: string;
  content: Buffer | string;
}

export interface CommitInput {
  files: SnapshotFile[];
  message: string;
  author: { name: string; email: string };
}

export interface RepoCommit {
  sha: string;
  message: string;
  author: string;
  at: string;
}

export interface RepoFile {
  path: string;
  size: number;
}

export class ArenaRepos {
  private readonly queues = new Map<string, Promise<unknown>>();
  private remotes: RemoteHooks | null = null;

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
  ) {}

  /** Turns on GitHub sync (ADR-040): set once at startup by the GitHub module. */
  useRemotes(hooks: RemoteHooks): void {
    this.remotes = hooks;
  }

  private dir(projectId: string): string {
    if (!UUID.test(projectId)) throw new Error('Not a project id');
    return join(this.root, projectId);
  }

  private git(cwd: string, args: string[], env: Record<string, string> = {}) {
    return run('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      maxBuffer: MAX_OUTPUT,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        ...env,
      },
    });
  }

  /** Runs `work` after this arena's earlier work (one at a time per arena). */
  private queue<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(projectId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(work);
    this.queues.set(projectId, next);
    const done = () => {
      if (this.queues.get(projectId) === next) this.queues.delete(projectId);
    };
    // Both branches handled: a failed step rejects only for its caller, never unhandled.
    void next.then(done, done);
    return next;
  }

  /** Resolves once this arena's queued commits are done (so a read sees them). */
  async settled(projectId: string): Promise<void> {
    await this.queues.get(projectId)?.catch(() => undefined);
  }

  private async ensure(projectId: string): Promise<string> {
    const dir = this.dir(projectId);
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir);
    if (!entries.includes('.git')) await this.git(dir, ['init', '-q', '-b', 'main']);
    return dir;
  }

  /** Removes the snapshot's own paths, writes `input` and commits it. Sha, or null if unchanged. */
  private async writeSnapshot(dir: string, input: CommitInput): Promise<string | null> {
    for (const entry of await readdir(dir)) {
      if (isManagedPath(entry)) await rm(join(dir, entry), { recursive: true, force: true });
    }
    const docs = join(dir, 'docs');
    for (const entry of await readdir(docs).catch(() => [] as string[])) {
      if (isManagedPath(`docs/${entry}`)) {
        await rm(join(docs, entry), { recursive: true, force: true });
      }
    }
    const base = resolve(dir) + sep;
    for (const file of input.files) {
      const target = resolve(dir, file.path);
      if (!target.startsWith(base)) continue; // never outside the repo
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
    // Unstage the logs' old lowercase names, so a case-insensitive disk records the rename.
    await this.git(dir, ['rm', '-q', '--cached', '--ignore-unmatch', 'progress.md', 'state.md']);
    await this.git(dir, ['add', '-A']);
    const { stdout: changed } = await this.git(dir, ['status', '--porcelain']);
    if (!changed.trim()) return null;
    const who = {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      ...PARALLELFLOW_COMMITTER,
    };
    await this.git(dir, ['commit', '-q', '-m', input.message], who);
    return this.revParse(dir, 'refs/heads/main');
  }

  /**
   * Replaces the snapshot's own paths (isManagedPath) with `files` and commits it; code merged from
   * pull requests stays. With `orgId` and a connected GitHub repository, the commit goes on top of
   * GitHub's default branch and is pushed (ADR-040); if GitHub fails, it is kept locally and the
   * next sync starts again from GitHub. Returns the new commit sha, or null when nothing changed.
   * Never throws: a failure is logged (ids only) and returns null.
   */
  commit(projectId: string, input: CommitInput, orgId?: string): Promise<string | null> {
    return this.queue(projectId, async () => {
      try {
        const dir = await this.ensure(projectId);
        const scope = orgId ? { orgId, projectId } : null;
        const link = scope && (await this.remoteOf(scope));
        let sha: string | null = null;
        let written = false;
        if (scope && link) {
          try {
            sha = await this.syncWrite(dir, link, async () => {
              written = true;
              return this.writeSnapshot(dir, input);
            });
            this.report(scope, null);
          } catch (err) {
            this.report(scope, syncReason(err));
            this.logger.warn(
              { projectId, err: err instanceof Error ? err.name : 'Error' },
              'arena repo: github sync failed',
            );
          }
        }
        if (!written) sha = await this.writeSnapshot(dir, input);
        if (sha) this.logger.info({ projectId, sha: sha.slice(0, 12) }, 'arena repo: committed');
        return sha;
      } catch (err) {
        this.logger.warn(
          { projectId, err: err instanceof Error ? err.name : 'Error' },
          'arena repo: commit failed',
        );
        return null;
      }
    });
  }

  // ---------------------------------------------------------------- GitHub (ADR-040)

  private async remoteOf(scope: RepoScope): Promise<RemoteLink | null> {
    if (!this.remotes) return null;
    try {
      return await this.remotes.resolve(scope);
    } catch (err) {
      this.logger.warn(
        { projectId: scope.projectId, err: err instanceof Error ? err.name : 'Error' },
        'arena repo: github lookup failed',
      );
      return null;
    }
  }

  private report(scope: RepoScope, error: string | null): void {
    this.remotes?.report(scope, error);
  }

  private async setOrigin(dir: string, url: string): Promise<void> {
    const { stdout } = await this.git(dir, ['remote']);
    const has = stdout.split('\n').some((line) => line.trim() === 'origin');
    await this.git(
      dir,
      has ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url],
    );
  }

  /** Fetches origin's branch; its sha, or null when GitHub has no such branch (an empty repo). */
  private async fetchRemote(
    dir: string,
    link: RemoteLink,
    env: Record<string, string>,
  ): Promise<string | null> {
    const ref = `refs/heads/${link.branch}`;
    let listed: string;
    try {
      listed = (await this.git(dir, ['ls-remote', 'origin', ref], env)).stdout;
    } catch {
      throw new RemoteSyncError(UNREACHABLE);
    }
    if (!listed.trim()) return null;
    const tracking = `refs/remotes/origin/${link.branch}`;
    try {
      await this.git(dir, ['fetch', '-q', '--no-tags', 'origin', `+${ref}:${tracking}`], env);
    } catch {
      throw new RemoteSyncError(UNREACHABLE);
    }
    const sha = await this.revParse(dir, tracking);
    if (!sha) throw new RemoteSyncError(UNREACHABLE);
    return sha;
  }

  /** Local main (and the working tree) at `sha`. */
  private async alignTo(dir: string, sha: string): Promise<void> {
    await this.git(dir, ['checkout', '-q', '-f', '-B', 'main', sha]);
    await this.git(dir, ['clean', '-q', '-fd']);
  }

  /** Pushes main to origin's branch, never with force. 'rejected' when GitHub moved meanwhile. */
  private async push(
    dir: string,
    link: RemoteLink,
    env: Record<string, string>,
  ): Promise<'ok' | 'rejected'> {
    try {
      await this.git(
        dir,
        ['push', '--porcelain', 'origin', `refs/heads/main:refs/heads/${link.branch}`],
        env,
      );
      return 'ok';
    } catch (err) {
      const out = `${String((err as { stdout?: unknown }).stdout ?? '')}${String(
        (err as { stderr?: unknown }).stderr ?? '',
      )}`;
      // "[rejected]" is a non-fast-forward; "[remote rejected]" (a protected branch) is not retried.
      if (/\[rejected\]|\(fetch first\)|\(non-fast-forward\)/.test(out)) return 'rejected';
      throw new RemoteSyncError(REFUSED);
    }
  }

  private async isAncestor(dir: string, ancestor: string, of: string): Promise<boolean> {
    try {
      await this.git(dir, ['merge-base', '--is-ancestor', ancestor, of]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Puts main at GitHub's branch, runs `apply` (a commit or merge on top) and pushes; on a rejected
   * push, fetches and runs `apply` again (PUSH_ATTEMPTS). Throws RemoteSyncError.
   */
  private async syncWrite<T>(dir: string, link: RemoteLink, apply: () => Promise<T>): Promise<T> {
    let env: Record<string, string>;
    try {
      env = remoteAuthEnv(link.url, await link.token());
    } catch {
      throw new RemoteSyncError(UNREACHABLE);
    }
    await this.setOrigin(dir, link.url);
    for (let attempt = 1; ; attempt += 1) {
      const remote = await this.fetchRemote(dir, link, env);
      if (remote) await this.alignTo(dir, remote);
      const result = await apply();
      const head = await this.revParse(dir, 'refs/heads/main');
      if (!head || head === remote) return result;
      if ((await this.push(dir, link, env)) === 'ok') return result;
      if (attempt >= PUSH_ATTEMPTS) throw new RemoteSyncError(BUSY);
    }
  }

  /**
   * First sync after connecting: keeps where main was (BEFORE_GITHUB_REF), then commits `input` on
   * top of GitHub's branch and pushes. An empty GitHub repository gets the arena's whole history.
   * Reports the outcome; never throws.
   */
  connect(scope: RepoScope, input: CommitInput): Promise<void> {
    return this.queue(scope.projectId, async () => {
      try {
        const link = await this.remoteOf(scope);
        if (!link) return;
        const dir = await this.ensure(scope.projectId);
        const before = await this.revParse(dir, 'refs/heads/main');
        if (before) await this.git(dir, ['update-ref', BEFORE_GITHUB_REF, before]);
        await this.syncWrite(dir, link, () => this.writeSnapshot(dir, input));
        this.report(scope, null);
        this.logger.info({ projectId: scope.projectId }, 'arena repo: github connected');
      } catch (err) {
        this.report(scope, syncReason(err));
        this.logger.warn(
          { projectId: scope.projectId, err: err instanceof Error ? err.name : 'Error' },
          'arena repo: github connect failed',
        );
      }
    });
  }

  /**
   * After a push or merge on GitHub (webhook) or "Sync now": main follows GitHub's branch. When
   * local main is only ahead (a commit whose push failed), it is pushed instead. Never throws.
   */
  pull(scope: RepoScope): Promise<void> {
    return this.queue(scope.projectId, async () => {
      try {
        const link = await this.remoteOf(scope);
        if (!link) return;
        const dir = await this.ensure(scope.projectId);
        const env = remoteAuthEnv(link.url, await link.token());
        await this.setOrigin(dir, link.url);
        const remote = await this.fetchRemote(dir, link, env);
        const local = await this.revParse(dir, 'refs/heads/main');
        if (remote && local !== remote) {
          const ahead = local !== null && (await this.isAncestor(dir, remote, local));
          if (!ahead || (await this.push(dir, link, env)) === 'rejected') {
            await this.alignTo(dir, remote);
          }
        } else if (!remote && local) {
          await this.push(dir, link, env);
        }
        this.report(scope, null);
      } catch (err) {
        this.report(scope, syncReason(err));
        this.logger.warn(
          { projectId: scope.projectId, err: err instanceof Error ? err.name : 'Error' },
          'arena repo: github pull failed',
        );
      }
    });
  }

  /** Forgets `origin`; the arena repo keeps its history and stays on the server. */
  disconnect(projectId: string): Promise<void> {
    return this.queue(projectId, async () => {
      const dir = this.dir(projectId);
      await this.git(dir, ['remote', 'remove', 'origin']).catch(() => undefined);
    });
  }

  /** Recent commits and the files at HEAD; empty when the arena has no repo yet. */
  async read(projectId: string, limit = 30): Promise<{ commits: RepoCommit[]; files: RepoFile[] }> {
    const dir = this.dir(projectId);
    try {
      const { stdout: log } = await this.git(dir, [
        'log',
        `-n${limit}`,
        '--format=%H%x1f%an%x1f%aI%x1f%s%x1e',
      ]);
      const commits = log
        .split('\x1e')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sha = '', author = '', at = '', message = ''] = line.split('\x1f');
          // %aI is local time with an offset: kept as a UTC instant, like every other time.
          const instant = Date.parse(at);
          return {
            sha,
            author,
            at: Number.isNaN(instant) ? at : new Date(instant).toISOString(),
            message,
          };
        });
      const { stdout: tree } = await this.git(dir, ['ls-tree', '-r', '-l', '-z', 'HEAD']);
      const files = tree
        .split('\0')
        .filter(Boolean)
        .map((entry) => {
          const tab = entry.indexOf('\t');
          const size = Number(entry.slice(0, tab).trim().split(/\s+/)[3] ?? 0);
          return { path: entry.slice(tab + 1), size };
        });
      return { commits, files };
    } catch {
      return { commits: [], files: [] };
    }
  }

  /** A file's content at a commit (default HEAD), or null. `path` must be a file in that tree. */
  async show(projectId: string, path: string, ref = 'HEAD'): Promise<Buffer | null> {
    const dir = this.dir(projectId);
    if (!/^[0-9a-f]{7,40}$|^HEAD$/.test(ref)) return null;
    try {
      const { stdout } = await this.git(dir, ['ls-tree', '-z', '--name-only', ref, '--', path]);
      if (stdout.split('\0')[0] !== path) return null;
      const out = await run('git', ['cat-file', 'blob', `${ref}:${path}`], {
        cwd: dir,
        maxBuffer: MAX_OUTPUT,
        windowsHide: true,
        encoding: 'buffer',
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
      });
      return out.stdout;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- branches and PRs (ADR-037)

  private async revParse(dir: string, ref: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(dir, [
        'rev-parse',
        '--verify',
        '--quiet',
        `${ref}^{commit}`,
      ]);
      const sha = stdout.trim();
      return SHA.test(sha) ? sha : null;
    } catch {
      return null;
    }
  }

  /** main's head; creates the repo with a first commit (`initial()`) when it has none. Throws. */
  ensureHead(projectId: string, initial: () => Promise<CommitInput>): Promise<string> {
    return this.queue(projectId, async () => {
      const dir = await this.ensure(projectId);
      const head = await this.revParse(dir, 'refs/heads/main');
      if (head) return head;
      const input = await initial();
      const base = resolve(dir) + sep;
      for (const file of input.files) {
        const target = resolve(dir, file.path);
        if (!target.startsWith(base)) continue;
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      await this.git(dir, ['add', '-A']);
      await this.git(dir, ['commit', '-q', '--allow-empty', '-m', input.message], {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        ...PARALLELFLOW_COMMITTER,
      });
      const sha = await this.revParse(dir, 'refs/heads/main');
      if (!sha) throw new Error('arena repo: no main after the first commit');
      return sha;
    });
  }

  /** `git bundle create - --all`: every branch, for the extension to clone or fetch. */
  bundle(projectId: string): Promise<Buffer> {
    return this.queue(projectId, async () => {
      const dir = await this.ensure(projectId);
      const out = await run(
        'git',
        ['-c', 'core.hooksPath=', 'bundle', 'create', '-q', '-', '--all'],
        {
          cwd: dir,
          maxBuffer: MAX_BUNDLE,
          windowsHide: true,
          encoding: 'buffer',
          env: { ...process.env, ...GIT_ENV },
        },
      );
      return out.stdout;
    });
  }

  /**
   * Takes `branch` from a pushed bundle (`git fetch <bundle> +refs/heads/<b>:refs/heads/<b>`): only
   * that ref is written, never main, so other refs in the bundle are ignored. Returns its new head.
   */
  fetchBundle(projectId: string, branch: string, bundle: Buffer): Promise<string> {
    if (branch === 'main' || !branch.startsWith('ai/') || branch.includes('..')) {
      return Promise.reject(new BundleError('Only ai/* branches can be pushed'));
    }
    return this.queue(projectId, async () => {
      const dir = await this.ensure(projectId);
      const tmp = await mkdtemp(join(tmpdir(), 'parallelflow-bundle-'));
      const file = join(tmp, 'push.bundle');
      try {
        await writeFile(file, bundle);
        let heads: string;
        try {
          heads = (await this.git(dir, ['bundle', 'list-heads', file])).stdout;
        } catch {
          throw new BundleError('This is not a git bundle');
        }
        const ref = `refs/heads/${branch}`;
        if (!heads.split('\n').some((line) => line.trim().endsWith(` ${ref}`))) {
          throw new BundleError(`The bundle has no ${ref}`);
        }
        try {
          await this.git(dir, ['fetch', '-q', '--no-tags', file, `+${ref}:${ref}`]);
        } catch {
          throw new BundleError(
            'git could not read the bundle. Fetch the arena repo and try again.',
          );
        }
        const sha = await this.revParse(dir, ref);
        if (!sha) throw new BundleError('The branch is missing after the push');
        return sha;
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  }

  private async ahead(dir: string, sha: string): Promise<number> {
    try {
      const { stdout } = await this.git(dir, ['rev-list', '--count', `refs/heads/main..${sha}`]);
      return Number(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  /** Commits of `sha` that main does not have. */
  async aheadOf(projectId: string, sha: string): Promise<number> {
    if (!SHA.test(sha)) return 0;
    await this.settled(projectId);
    return this.ahead(this.dir(projectId), sha);
  }

  /** The `ai/*` branches, newest first, with their heads and commits ahead of main. */
  async branches(projectId: string): Promise<BranchInfo[]> {
    await this.settled(projectId);
    const dir = this.dir(projectId);
    try {
      const { stdout } = await this.git(dir, [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname:short)%1f%(objectname)%1f%(committerdate:iso-strict)',
        'refs/heads/ai/',
      ]);
      const rows = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name = '', sha = '', at = ''] = l.split('\x1f');
          return { name, sha, at };
        });
      return await Promise.all(
        rows.map(async (r) => ({ ...r, ahead: await this.ahead(dir, r.sha) })),
      );
    } catch {
      return [];
    }
  }

  /**
   * The PR view: `git log <base>..<head>` and `git diff <base>...<head>` per file, within DIFF_LIMITS.
   * `base` is main, or for a merged PR the first parent of its merge commit (`<sha>^1`).
   */
  async pullDiff(projectId: string, head: string, base = 'refs/heads/main'): Promise<PullDiff> {
    const empty: PullDiff = { commits: [], files: [], truncated: false };
    if (!SHA.test(head) || !(base === 'refs/heads/main' || /^[0-9a-f]{40}\^1$/.test(base))) {
      return empty;
    }
    await this.settled(projectId);
    const dir = this.dir(projectId);
    try {
      const { stdout: log } = await this.git(dir, [
        'log',
        `-n${DIFF_LIMITS.commits}`,
        '--format=%H%x1f%an%x1f%aI%x1f%s%x1e',
        `${base}..${head}`,
      ]);
      const commits = log
        .split('\x1e')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [sha = '', author = '', at = '', message = ''] = line.split('\x1f');
          // %aI is local time with an offset: kept as a UTC instant, like every other time.
          const instant = Date.parse(at);
          return {
            sha,
            author,
            at: Number.isNaN(instant) ? at : new Date(instant).toISOString(),
            message,
          };
        });
      const range = `${base}...${head}`;
      const diff = (extra: string[]) => this.git(dir, ['diff', '--no-renames', ...extra, range]);
      const [{ stdout: numstat }, { stdout: status }, { stdout: patch }] = await Promise.all([
        diff(['--numstat', '-z']),
        diff(['--name-status', '-z']),
        diff(['--no-color', '--no-ext-diff']),
      ]);
      return { ...parseDiff(numstat, status, patch), commits };
    } catch {
      return empty;
    }
  }

  /**
   * Merges `sha` into main with `git merge --no-ff` (author = the merger, committer = ParallelFlow). On a
   * conflict the merge is aborted, main is unchanged and MergeConflictError is thrown. With `orgId`
   * and a connected GitHub repository the merge goes on top of GitHub's branch and is pushed; if
   * that fails, main goes back to GitHub's branch and RemoteSyncError is thrown.
   */
  merge(
    projectId: string,
    input: { sha: string; message: string; author: { name: string; email: string } },
    orgId?: string,
  ): Promise<string> {
    if (!SHA.test(input.sha)) return Promise.reject(new Error('Not a commit sha'));
    return this.queue(projectId, async () => {
      const dir = await this.ensure(projectId);
      const scope = orgId ? { orgId, projectId } : null;
      const link = scope && (await this.remoteOf(scope));
      const sha =
        scope && link
          ? await this.syncWrite(dir, link, () => this.mergeLocal(dir, input)).then(
              (merged) => {
                this.report(scope, null);
                return merged;
              },
              async (err: unknown) => {
                if (!(err instanceof RemoteSyncError)) throw err;
                this.report(scope, err.reason);
                const tracking = await this.revParse(dir, `refs/remotes/origin/${link.branch}`);
                if (tracking) await this.alignTo(dir, tracking).catch(() => undefined);
                throw err;
              },
            )
          : await this.mergeLocal(dir, input);
      this.logger.info({ projectId, sha: sha.slice(0, 12) }, 'arena repo: merged');
      return sha;
    });
  }

  private async mergeLocal(
    dir: string,
    input: { sha: string; message: string; author: { name: string; email: string } },
  ): Promise<string> {
    await this.git(dir, ['checkout', '-q', 'main']);
    try {
      await this.git(dir, ['merge', '-q', '--no-ff', '--no-edit', '-m', input.message, input.sha], {
        GIT_AUTHOR_NAME: input.author.name,
        GIT_AUTHOR_EMAIL: input.author.email,
        ...PARALLELFLOW_COMMITTER,
      });
    } catch {
      await this.git(dir, ['merge', '--abort']).catch(() => undefined);
      await this.git(dir, ['reset', '-q', '--hard', 'HEAD']).catch(() => undefined);
      throw new MergeConflictError();
    }
    const sha = await this.revParse(dir, 'refs/heads/main');
    if (!sha) throw new Error('arena repo: no main after the merge');
    return sha;
  }
}
