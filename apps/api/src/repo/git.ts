import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '@saras/observability';

// One git repository per arena (Phase A: local only; pushing to a remote comes later, SLICE_DEBT).
// Every approved gate writes the arena's approved state (snapshot.ts) into the repo's working tree and
// commits it as the approver, so the arena's history is a plain git log anyone can clone and read.
//
// Safety: git runs with execFile and an argument list (never a shell); paths come from
// snapshot.ts's sanitiser and are checked to stay inside the repo; each arena's work runs one at a
// time (a per-arena queue). The repo is app data: hooks, signing and the user's global config do
// not apply (GIT_CONFIG_GLOBAL / NOSYSTEM). Contents and messages are never logged.

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_OUTPUT = 20 * 1024 * 1024;

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
    void next.finally(() => {
      if (this.queues.get(projectId) === next) this.queues.delete(projectId);
    });
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
   * Replaces the working tree with `files` and commits it. Returns the new commit sha, or null when
   * nothing changed. Never throws: a failure is logged (ids only) and returns null.
   */
  commit(projectId: string, input: CommitInput): Promise<string | null> {
    return this.queue(projectId, async () => {
      try {
        const dir = await this.ensure(projectId);
        for (const entry of await readdir(dir)) {
          if (entry !== '.git') await rm(join(dir, entry), { recursive: true, force: true });
        }
        const base = resolve(dir) + sep;
        for (const file of input.files) {
          const target = resolve(dir, file.path);
          if (!target.startsWith(base)) continue; // never outside the repo
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.content);
        }
        await this.git(dir, ['add', '-A']);
        const { stdout: changed } = await this.git(dir, ['status', '--porcelain']);
        if (!changed.trim()) return null;
        const who = {
          GIT_AUTHOR_NAME: input.author.name,
          GIT_AUTHOR_EMAIL: input.author.email,
          GIT_COMMITTER_NAME: 'Saras',
          GIT_COMMITTER_EMAIL: 'noreply@saras.app',
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
          return { sha, author, at, message };
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
}
