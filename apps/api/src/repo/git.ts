import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '@parallelflow/observability';

// One git repository per arena (Phase A: local only; pushing to a remote comes later, SLICE_DEBT).
// Every approved gate writes the arena's approved state (snapshot.ts) into the repo's working tree and
// commits it as the approver, so the arena's history is a plain git log anyone can clone and read.
// The snapshot owns only README.md, PROGRESS.md, STATE.md, cycle-*/ and docs/ (isManagedPath); code
// reaches main only by merging a reviewed pull request from an `ai/*` branch (ADR-037), and a
// snapshot never removes it. The working tree is always main, clean after each queued step.
//
// Safety: git runs with execFile and an argument list (never a shell); paths come from
// snapshot.ts's sanitiser and are checked to stay inside the repo; each arena's work runs one at a
// time (a per-arena queue). The repo is app data: hooks, signing and the user's global config do
// not apply (GIT_CONFIG_GLOBAL / NOSYSTEM). Contents and messages are never logged.

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OUTPUT = 20 * 1024 * 1024;
/** Largest repo bundle sent to the extension. */
const MAX_BUNDLE = 200 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;

/** Root entries the docs snapshot owns (and may replace). Everything else is code from PRs. */
export function isManagedPath(entry: string): boolean {
  return (
    entry === 'README.md' ||
    entry === 'PROGRESS.md' ||
    entry === 'STATE.md' ||
    // The logs' names before 24 Oct, so the next snapshot replaces them with the uppercase ones.
    entry === 'progress.md' ||
    entry === 'state.md' ||
    entry === 'docs' ||
    /^cycle-\d+$/.test(entry)
  );
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

  constructor(
    private readonly root: string,
    private readonly logger: Logger,
  ) {}

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

  /**
   * Replaces the snapshot's own paths (isManagedPath) with `files` and commits it; code merged from
   * pull requests stays. Returns the new commit sha, or null when nothing changed. Never throws: a
   * failure is logged (ids only) and returns null.
   */
  commit(projectId: string, input: CommitInput): Promise<string | null> {
    return this.queue(projectId, async () => {
      try {
        const dir = await this.ensure(projectId);
        for (const entry of await readdir(dir)) {
          if (isManagedPath(entry)) await rm(join(dir, entry), { recursive: true, force: true });
        }
        const base = resolve(dir) + sep;
        for (const file of input.files) {
          const target = resolve(dir, file.path);
          if (!target.startsWith(base)) continue; // never outside the repo
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content);
        }
        // Unstage the logs' old lowercase names, so a case-insensitive disk records the rename.
        await this.git(dir, [
          'rm',
          '-q',
          '--cached',
          '--ignore-unmatch',
          'progress.md',
          'state.md',
        ]);
        await this.git(dir, ['add', '-A']);
        const { stdout: changed } = await this.git(dir, ['status', '--porcelain']);
        if (!changed.trim()) return null;
        const who = {
          GIT_AUTHOR_NAME: input.author.name,
          GIT_AUTHOR_EMAIL: input.author.email,
          GIT_COMMITTER_NAME: 'ParallelFlow',
          GIT_COMMITTER_EMAIL: 'noreply@parallelflow.app',
        };
        await this.git(dir, ['commit', '-q', '-m', input.message], who);
        const { stdout } = await this.git(dir, ['rev-parse', 'HEAD']);
        const sha = stdout.trim();
        this.logger.info({ projectId, sha: sha.slice(0, 12) }, 'arena repo: committed');
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
   * conflict the merge is aborted, main is unchanged and MergeConflictError is thrown.
   */
  merge(
    projectId: string,
    input: { sha: string; message: string; author: { name: string; email: string } },
  ): Promise<string> {
    if (!SHA.test(input.sha)) return Promise.reject(new Error('Not a commit sha'));
    return this.queue(projectId, async () => {
      const dir = await this.ensure(projectId);
      await this.git(dir, ['checkout', '-q', 'main']);
      try {
        await this.git(
          dir,
          ['merge', '-q', '--no-ff', '--no-edit', '-m', input.message, input.sha],
          {
            GIT_AUTHOR_NAME: input.author.name,
            GIT_AUTHOR_EMAIL: input.author.email,
            ...PARALLELFLOW_COMMITTER,
          },
        );
      } catch {
        await this.git(dir, ['merge', '--abort']).catch(() => undefined);
        await this.git(dir, ['reset', '-q', '--hard', 'HEAD']).catch(() => undefined);
        throw new MergeConflictError();
      }
      const sha = await this.revParse(dir, 'refs/heads/main');
      if (!sha) throw new Error('arena repo: no main after the merge');
      this.logger.info({ projectId, sha: sha.slice(0, 12) }, 'arena repo: merged');
      return sha;
    });
  }
}
