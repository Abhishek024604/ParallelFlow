// Building from an arena's GitHub repository (ADR-042). The developer signs in with VS Code's own
// GitHub account (vscode.authentication), and the extension, never the agent, clones, fetches,
// pushes and opens the pull request as that person. The token is handed to git only through
// GIT_CONFIG_* environment variables of that one git process: never in argv, a remote URL or
// .git/config, and never in the Pi agent's environment. It is never stored or logged.
import { type GitRunner, isSafeBranch, runGit } from './git.js';

const GITHUB_ORIGIN = 'https://github.com/';
const API = 'https://api.github.com';

/** Environment for one git process that authenticates to github.com with `token`. */
export function githubGitEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${GITHUB_ORIGIN}.extraHeader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    // No credential manager: nothing is cached, nothing prompts.
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
  };
}

/** The arena's repository on GitHub (GET /v1/projects/:p/github → repo). */
export interface GithubRepo {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string;
  defaultBranch: string;
}

const CLONE_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\.git$/;

export function isGithubCloneUrl(url: string): boolean {
  return CLONE_URL.test(url);
}

// ---- Stories and branches -----------------------------------------------------------------------

export interface Story {
  /** STORY-007 */
  id: string;
  title: string;
  /** Repo-relative, forward slashes. */
  path: string;
}

/** Lowercase words joined by '-', at most 40 characters, never empty. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'task';
}

/** feat/story-007-pay-by-card, or feat/<slug> for a task that is not a story. */
export function taskBranch(title: string, storyId?: string): string {
  const id = storyId?.toLowerCase();
  const rest = id && title.toLowerCase().startsWith(id) ? title.slice(id.length) : title;
  const titleSlug = slugify(rest);
  const branch = id ? `feat/${id}-${titleSlug}` : `feat/${titleSlug}`;
  if (!isSafeBranch(branch)) throw new Error(`Cannot name a branch for ${title}`);
  return branch;
}

const STORY_FILE = /^(STORY-\d{1,6})(?:[-_.][^/]*)?\.md$/i;

/** A story from its backlog file (docs/product/backlog/STORY-*.md), or undefined. */
export function parseStory(
  fileName: string,
  text: string,
  dir = 'docs/product/backlog',
): Story | undefined {
  const m = STORY_FILE.exec(fileName);
  if (!m?.[1]) return undefined;
  const id = m[1].toUpperCase();
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const fromFront = /^title:\s*["']?(.+?)["']?\s*$/m.exec(front)?.[1];
  const heading = /^#\s+(.+)$/m.exec(text)?.[1];
  const title = (fromFront ?? heading ?? id)
    .replace(new RegExp(`^${id}\\s*[:·—-]?\\s*`, 'i'), '')
    .trim()
    .slice(0, 150);
  return { id, title: title || id, path: `${dir}/${fileName}` };
}

// ---- Pull request text --------------------------------------------------------------------------

export type CheckResult = { name: string; status: 'passed' | 'failed' | 'not-run' };

export interface PullBodyInput {
  summary: string[];
  story?: Story;
  /** Repo-relative paths of the design docs the work followed. */
  docs: string[];
  repo: GithubRepo;
  branch: string;
  checks: CheckResult[];
}

export function pullTitle(title: string, story?: Story): string {
  const t = story ? `${story.id}: ${story.title}` : title;
  return t.slice(0, 250);
}

const blob = (repo: GithubRepo, branch: string, path: string) =>
  `${repo.htmlUrl}/blob/${branch.split('/').map(encodeURIComponent).join('/')}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

/** The pull request description: summary, story, design docs and a checklist. */
export function pullBody(input: PullBodyInput): string {
  const { repo, branch } = input;
  const lines: string[] = ['## Summary', ''];
  if (input.summary.length) lines.push(...input.summary.slice(0, 30).map((s) => `- ${s}`));
  else lines.push('- (no commits yet)');
  if (input.story) {
    lines.push(
      '',
      `Implements ${input.story.id}: [${input.story.title}](${blob(repo, branch, input.story.path)})`,
    );
  }
  if (input.docs.length) {
    lines.push('', '## Design docs followed', '');
    for (const d of input.docs.slice(0, 40)) lines.push(`- [${d}](${blob(repo, branch, d)})`);
  }
  lines.push('', '## Checklist', '');
  const mark = (c: CheckResult) =>
    c.status === 'passed'
      ? `- [x] \`${c.name}\` passed`
      : c.status === 'failed'
        ? `- [ ] \`${c.name}\` failed`
        : `- [ ] \`${c.name}\` not run`;
  if (input.checks.length) lines.push(...input.checks.map(mark));
  else lines.push('- [ ] Tests pass');
  lines.push(
    '- [ ] Docs updated (docs/design/architecture, README) where behaviour changed',
    '- [ ] Reviewed by a teammate',
    '',
    '_Opened from VS Code with ParallelFlow. Code written with the ParallelFlow coding agent; a person reviews and merges._',
  );
  return lines.join('\n');
}

// ---- GitHub REST, as the developer --------------------------------------------------------------

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GithubPull {
  number: number;
  html_url: string;
  draft: boolean;
  state: string;
}

export class GithubRestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubRestError';
  }
}

export class GithubRest {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new GithubRestError(0, 'GitHub could not be reached.');
    }
    const json = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!res.ok) {
      const detail = typeof json?.message === 'string' ? json.message.slice(0, 200) : '';
      throw new GithubRestError(
        res.status,
        `GitHub said ${res.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return json as T;
  }

  /** The open pull request for `branch` (head owner:branch), if there is one. */
  async findPull(repo: GithubRepo, branch: string): Promise<GithubPull | undefined> {
    const q = new URLSearchParams({ head: `${repo.owner}:${branch}`, state: 'open' });
    const list = await this.call<GithubPull[]>(
      'GET',
      `/repos/${repo.owner}/${repo.name}/pulls?${q.toString()}`,
    );
    return Array.isArray(list) ? list[0] : undefined;
  }

  createPull(
    repo: GithubRepo,
    input: { title: string; body: string; head: string; draft: boolean },
  ): Promise<GithubPull> {
    return this.call('POST', `/repos/${repo.owner}/${repo.name}/pulls`, {
      ...input,
      base: repo.defaultBranch,
    });
  }

  updatePull(
    repo: GithubRepo,
    number: number,
    input: { title: string; body: string },
  ): Promise<GithubPull> {
    return this.call('PATCH', `/repos/${repo.owner}/${repo.name}/pulls/${number}`, input);
  }
}

// ---- Git against GitHub -------------------------------------------------------------------------

export class GithubGit {
  constructor(
    private readonly token: () => Promise<string>,
    private readonly run: GitRunner = runGit,
  ) {}

  /** Clones into `target` (an empty folder) and disables `git push` to origin for anyone else. */
  async clone(repo: GithubRepo, target: string): Promise<void> {
    if (!isGithubCloneUrl(repo.cloneUrl)) throw new Error('Not a GitHub repository address.');
    await this.run(
      ['clone', '--origin', 'origin', '--branch', repo.defaultBranch, '--', repo.cloneUrl, target],
      target,
      githubGitEnv(await this.token()),
    );
    // The agent's shell has no GitHub credentials; this makes a stray `git push` fail plainly too.
    await this.run(
      ['config', 'remote.origin.pushurl', 'no-push://use-parallelflow-open-pull-request'],
      target,
    );
  }

  async fetch(cwd: string, repo: GithubRepo): Promise<void> {
    await this.run(
      [
        'fetch',
        '--prune',
        '--',
        repo.cloneUrl,
        `+refs/heads/${repo.defaultBranch}:refs/remotes/origin/${repo.defaultBranch}`,
      ],
      cwd,
      githubGitEnv(await this.token()),
    );
  }

  /** A new task branch from the freshly fetched default branch (or the existing one). */
  async startBranch(cwd: string, repo: GithubRepo, branch: string): Promise<string> {
    if (!isSafeBranch(branch) || branch === repo.defaultBranch) {
      throw new Error(`Unsafe branch name: ${branch}`);
    }
    await this.fetch(cwd, repo);
    const base = (
      await this.run(['rev-parse', `refs/remotes/origin/${repo.defaultBranch}`], cwd)
    ).trim();
    const existing = await this.run(['branch', '--list', branch], cwd);
    if (existing.trim()) await this.run(['switch', branch], cwd);
    else await this.run(['switch', '-c', branch, '--no-track', base], cwd);
    return base;
  }

  async push(cwd: string, repo: GithubRepo, branch: string): Promise<void> {
    if (!isSafeBranch(branch) || branch === repo.defaultBranch) {
      throw new Error(`Refusing to push ${branch}.`);
    }
    await this.run(
      ['push', '--', repo.cloneUrl, `refs/heads/${branch}:refs/heads/${branch}`],
      cwd,
      githubGitEnv(await this.token()),
    );
  }

  /** Commit subjects on `branch` that the default branch lacks, oldest first. */
  async subjects(cwd: string, repo: GithubRepo, branch: string): Promise<string[]> {
    const out = await this.run(
      ['log', '--reverse', '--format=%s', `refs/remotes/origin/${repo.defaultBranch}..${branch}`],
      cwd,
    );
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  }
}
