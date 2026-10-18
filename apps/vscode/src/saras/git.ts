// Git through execFile (no shell), always with an explicit cwd. Used for task branches, bundles for
// push, and cloning the arena repo from a bundle.
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';

export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const first =
            String(stderr)
              .split('\n')
              .find((l) => l.trim()) ?? err.message;
          reject(new Error(`git ${args[0]} failed: ${first.trim()}`));
        } else resolve(String(stdout));
      },
    );
  });

const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9._\-/]+(?<!\.lock)(?<![/.])$/;

export function isSafeBranch(name: string): boolean {
  return SAFE_BRANCH.test(name) && name !== 'main' && name !== 'master' && name !== 'HEAD';
}

export class Git {
  constructor(
    private readonly cwd: string,
    private readonly run: GitRunner = runGit,
  ) {}

  async isRepo(): Promise<boolean> {
    try {
      return (await this.run(['rev-parse', '--is-inside-work-tree'], this.cwd)).trim() === 'true';
    } catch {
      return false;
    }
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd)).trim();
  }

  async isClean(): Promise<boolean> {
    return (await this.run(['status', '--porcelain'], this.cwd)).trim() === '';
  }

  async hasCommit(sha: string): Promise<boolean> {
    try {
      await this.run(['cat-file', '-e', `${sha}^{commit}`], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** Create (or reset) the task branch at base and switch to it. */
  async checkoutTaskBranch(branch: string, baseSha: string): Promise<void> {
    if (!isSafeBranch(branch)) throw new Error(`Saras sent an unsafe branch name: ${branch}`);
    if (!(await this.hasCommit(baseSha))) {
      throw new Error(
        'The task base commit is not in this folder. Run "Saras: Clone arena repo" (or fetch from Saras) first.',
      );
    }
    const existing = await this.run(['branch', '--list', branch], this.cwd);
    if (existing.trim()) await this.run(['switch', branch], this.cwd);
    else await this.run(['switch', '-c', branch, baseSha], this.cwd);
  }

  async commitCount(base: string, branch: string): Promise<number> {
    const out = await this.run(['rev-list', '--count', `${base}..${branch}`], this.cwd);
    return Number(out.trim()) || 0;
  }

  /** Bundle the branch's commits on top of base (the server already has base). */
  async bundleBranch(branch: string, base: string, file: string): Promise<void> {
    if (!isSafeBranch(branch)) throw new Error(`Unsafe branch name: ${branch}`);
    await this.run(['bundle', 'create', file, branch, `^${base}`], this.cwd);
  }

  /** Fetch every branch of a bundle into refs/remotes/saras/*. */
  async fetchBundle(file: string): Promise<void> {
    await this.run(['fetch', '--no-tags', file, '+refs/heads/*:refs/remotes/saras/*'], this.cwd);
  }

  /**
   * Make this (non-git) folder a checkout of the arena repo from a bundle, in place. An empty folder
   * gets the arena's main checked out. A folder with files keeps them all: main points at the
   * arena's main, files the arena has that are missing here are restored, and everything else shows
   * up as local changes to review (nothing is overwritten or deleted).
   */
  async connectToBundle(file: string): Promise<'checked-out' | 'kept-files'> {
    await this.run(['init', '-q', '-b', 'main'], this.cwd);
    await this.fetchBundle(file);
    const main = 'refs/remotes/saras/main';
    const local = (await this.run(['status', '--porcelain', '--untracked-files=normal'], this.cwd))
      .split('\n')
      .filter((line) => line.trim());
    if (!local.length) {
      await this.run(['checkout', '-q', '-B', 'main', main], this.cwd);
      return 'checked-out';
    }
    await this.run(['reset', '-q', main], this.cwd);
    const missing = (await this.run(['ls-files', '-d', '-z'], this.cwd))
      .split('\0')
      .filter(Boolean);
    for (let i = 0; i < missing.length; i += 100) {
      await this.run(['checkout', '--', ...missing.slice(i, i + 100)], this.cwd);
    }
    return 'kept-files';
  }
}

export async function cloneBundle(
  file: string,
  target: string,
  run: GitRunner = runGit,
): Promise<void> {
  await run(['clone', '--no-hardlinks', '--origin', 'saras', file, target], dirname(target));
}
