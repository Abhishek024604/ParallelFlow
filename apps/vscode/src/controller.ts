// Ties the three layers together for one VS Code window: ParallelFlow sign-in and arena link, the Pi agent
// process (Layer 1) with parallelflow-guard, the codebase MCP server (Layer 2), and the sidebar, status
// bar and approval prompts (Layer 3).
import { type ChildProcess, exec, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ApprovalAnswer, ApprovalBroker, type ApprovalRequest } from './approvals/broker.js';
import { handleUiRequest } from './approvals/ui-bridge.js';
import { type RunningMcpServer, startMcpServer } from './intel/mcp-server.js';
import { refreshArchitecture } from './intel/tools.js';
import { createVscodeBackend, ensureParallelFlowDir } from './intel/vscode-backend.js';
import { buildPiLaunch, nodeVersionOk } from './pi/launcher.js';
import {
  type AgentMode,
  type AgentRouter,
  AUTO_MODEL,
  arenaBrief,
  CLAUDE_PROVIDER,
  CLAUDE_ROUTER,
  claudeTokenFrom,
  CODER_COMMANDS,
  CODER_REPO_RULES,
  CODER_SKILLS,
  type ModelSource,
  routerFrom,
  PARALLELFLOW_PROVIDER,
} from './shared/agent-config.js';
import { PiRpc } from './pi/rpc.js';
import { listSessions, sessionDirFor } from './pi/sessions.js';
import { Transcript } from './pi/transcript.js';
import {
  type Arena,
  type LlmModel,
  ParallelFlowApi,
  ParallelFlowApiError,
  ParallelFlowAuthError,
} from './parallelflow/api.js';
import { DeviceFlowError, runDeviceFlow } from './parallelflow/device-flow.js';
import { cloneBundle, Git } from './parallelflow/git.js';
import {
  type CheckResult,
  GithubGit,
  type GithubRepo,
  GithubRest,
  isGithubCloneUrl,
  parseStory,
  pullBody,
  pullTitle,
  type Story,
  taskBranch,
} from './parallelflow/github.js';
import { isTestCommand, ProgressReporter, progressSummary } from './parallelflow/progress.js';
import type {
  AgentStatus,
  FromWebview,
  Isolation,
  TaskView,
  ViewState,
} from './shared/messages.js';
import { detectIsolation, reopenInContainer, scaffoldDevContainer } from './ui/devcontainer.js';
import { ArchitectWatcher, archFile } from './ui/architect.js';
import type { SidebarProvider } from './ui/sidebar.js';

const TOKEN_KEY = 'parallelflow.token';
/** The person's Claude subscription token (`claude setup-token`), when they connect one. */
const CLAUDE_TOKEN_KEY = 'parallelflow.claudeToken';
const USER_KEY = 'parallelflow.user';
const LINK_KEY = 'parallelflow.link';
const TASK_KEY = 'parallelflow.task';
const HISTORY_KEY = 'parallelflow.history';

interface StoredToken {
  token: string;
  expiresAt: number;
}
interface Link {
  arenaId: string;
  arenaName: string;
}

function config() {
  const c = vscode.workspace.getConfiguration('parallelflow');
  return {
    url: c.get<string>('url', 'http://localhost:3000'),
    allowlist: c.get<string[]>('commandAllowlist', []),
    autoApproveEdits: c.get<boolean>('autoApproveEdits', true),
    approvalTimeoutMs: Math.max(10, c.get<number>('approvalTimeoutSeconds', 300)) * 1000,
    nodePath: c.get<string>('nodePath', 'node') || 'node',
    piPath: c.get<string>('piPath', ''),
    model: c.get<string>('model', ''),
    modelSource: (c.get<string>('modelSource', 'parallelflow') === 'claude'
      ? 'claude'
      : 'parallelflow') as ModelSource,
    mode: (c.get<string>('mode', 'coder') === 'architect' ? 'architect' : 'coder') as AgentMode,
  };
}

/** SWA's skill folders or prompt templates, copied to dist/swa by esbuild.mjs. */
async function swaFiles(dist: string, kind: 'skills' | 'prompts'): Promise<string[]> {
  const dir = path.join(dist, 'swa', kind);
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => (kind === 'skills' ? e.isDirectory() : e.name.endsWith('.md')))
    .map((e) => path.join(dir, e.name))
    .sort();
}

export class ParallelFlowController implements vscode.Disposable {
  readonly broker = new ApprovalBroker();
  private transcript = new Transcript();
  private sidebar: SidebarProvider | undefined;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private api: ParallelFlowApi;
  private user: { displayName: string; email: string } | undefined;
  private signIn: { userCode: string; uri: string; abort: AbortController } | undefined;
  private arena: Arena | undefined;
  private link: Link | undefined;
  /** The linked arena's GitHub repository, when it has one (ADR-042). */
  private githubRepo: GithubRepo | undefined;
  private isolation: Isolation = 'host';
  private agentStatus: AgentStatus = 'off';
  private agentError: string | undefined;
  private model: string | undefined;
  private child: ChildProcess | undefined;
  private rpc: PiRpc | undefined;
  private mcp: RunningMcpServer | undefined;
  private task: TaskView | undefined;
  private progress: ProgressReporter | undefined;
  private emitTimer: NodeJS.Timeout | undefined;
  private blockedReported = false;
  private taskRunning = false;
  /** Architect mode: the arch/ gates for the sidebar. */
  private readonly architect = new ArchitectWatcher(() => this.scheduleEmit());

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.api = this.makeApi();
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    this.status.command = 'parallelflow.sidebar.focus';
    this.status.show();
    this.user = ctx.globalState.get(USER_KEY);
    this.link = ctx.workspaceState.get<Link>(LINK_KEY);
    this.task = ctx.workspaceState.get<TaskView>(TASK_KEY);
    this.disposables.push(
      this.status,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('parallelflow.url')) {
          this.api = this.makeApi();
          this.emit();
        }
        if (e.affectsConfiguration('parallelflow.mode')) void this.onModeChanged();
        if (
          e.affectsConfiguration('parallelflow.modelSource') ||
          e.affectsConfiguration('parallelflow.model')
        )
          void this.onModeChanged();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => undefined),
      this.architect,
    );
    this.broker.onChange((open) => this.onApprovalsChanged(open));
    void this.init();
  }

  attachSidebar(sidebar: SidebarProvider): void {
    this.sidebar = sidebar;
    this.emit();
  }

  get root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private makeApi(): ParallelFlowApi {
    return new ParallelFlowApi({
      baseUrl: config().url,
      getToken: () => this.token(),
      onUnauthorized: () => void this.handleUnauthorized(),
    });
  }

  private async init(): Promise<void> {
    this.isolation = await detectIsolation(this.root);
    await this.architect.watch(this.root);
    if (!this.link && this.root) {
      // A folder cloned or linked before keeps its arena in .parallelflow/config.json.
      try {
        const raw = JSON.parse(
          await fsp.readFile(path.join(this.root, '.parallelflow', 'config.json'), 'utf8'),
        ) as Partial<Link>;
        if (typeof raw.arenaId === 'string' && typeof raw.arenaName === 'string') {
          this.link = { arenaId: raw.arenaId, arenaName: raw.arenaName };
          await this.ctx.workspaceState.update(LINK_KEY, this.link);
        }
      } catch {
        // not linked
      }
    }
    if (await this.token()) {
      await this.refreshArena();
      // Pick up the folder's last chat after a reload, so it is on screen before the next message.
      if (this.root && (await listSessions(this.sessionDir(this.root), 1)).length) {
        await this.ensureAgent().catch((err: unknown) => this.failAgent(err));
      }
    }
    this.emit();
  }

  // ---- Auth ------------------------------------------------------------------------------------

  private async token(): Promise<string | undefined> {
    const raw = await this.ctx.secrets.get(TOKEN_KEY);
    if (!raw) return undefined;
    try {
      const t = JSON.parse(raw) as StoredToken;
      if (Date.now() >= t.expiresAt) return undefined;
      return t.token;
    } catch {
      return undefined;
    }
  }

  async signInFlow(): Promise<void> {
    if (this.signIn) return;
    const abort = new AbortController();
    try {
      const token = await runDeviceFlow({
        deviceCode: (name) => this.api.deviceCode(name),
        deviceToken: (code) => this.api.deviceToken(code),
        present: async (code) => {
          this.signIn = { userCode: code.user_code, uri: code.verification_uri_complete, abort };
          this.emit();
          await vscode.env.openExternal(vscode.Uri.parse(code.verification_uri_complete));
        },
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
              clearTimeout(t);
              resolve();
            });
          }),
        now: () => Date.now(),
        signal: abort.signal,
        clientName: `VS Code on ${os.hostname()}`,
      });
      await this.ctx.secrets.store(
        TOKEN_KEY,
        JSON.stringify({
          token: token.access_token,
          expiresAt: Date.now() + token.expires_in * 1000 - 60_000,
        }),
      );
      this.user = { displayName: token.user.display_name, email: token.user.email };
      await this.ctx.globalState.update(USER_KEY, this.user);
      void vscode.window.showInformationMessage(
        `Signed in to ParallelFlow as ${this.user.displayName}.`,
      );
      await this.refreshArena();
    } catch (err) {
      if (!(err instanceof DeviceFlowError && err.reason === 'cancelled')) this.showError(err);
    } finally {
      this.signIn = undefined;
      this.emit();
    }
  }

  cancelSignIn(): void {
    this.signIn?.abort.abort();
  }

  async signOut(): Promise<void> {
    await this.stopAgent();
    await this.ctx.secrets.delete(TOKEN_KEY);
    this.user = undefined;
    await this.ctx.globalState.update(USER_KEY, undefined);
    this.emit();
  }

  private async handleUnauthorized(): Promise<void> {
    await this.ctx.secrets.delete(TOKEN_KEY);
    this.user = undefined;
    this.emit();
    const pick = await vscode.window.showWarningMessage(
      'Your ParallelFlow sign-in expired.',
      'Sign in',
    );
    if (pick) await this.signInFlow();
  }

  // ---- Arena link ------------------------------------------------------------------------------

  private async refreshArena(): Promise<void> {
    if (!this.link) {
      this.arena = undefined;
      this.githubRepo = undefined;
      return;
    }
    try {
      const arenas = await this.api.arenas();
      this.arena = arenas.find((a) => a.id === this.link?.arenaId);
      if (!this.arena) this.agentError = `You are no longer a member of ${this.link.arenaName}.`;
      else this.githubRepo = await this.arenaGithub(this.arena.id).catch(() => undefined);
    } catch (err) {
      if (!(err instanceof ParallelFlowAuthError)) this.agentError = (err as Error).message;
    }
  }

  async linkArena(): Promise<void> {
    if (!this.root) {
      void vscode.window.showWarningMessage('Open a folder first.');
      return;
    }
    if (!(await this.ensureSignedIn())) return;
    try {
      const arenas = await this.api.arenas();
      if (arenas.length === 0) {
        void vscode.window.showInformationMessage(
          'You are not in any arena yet. Create one on ParallelFlow first.',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        arenas.map((a) => ({
          label: a.name,
          description: [a.key, a.stage, a.role].filter(Boolean).join(' · '),
          arena: a,
        })),
        { placeHolder: 'Link this folder to an arena' },
      );
      if (!pick) return;
      await this.setLink({ arenaId: pick.arena.id, arenaName: pick.arena.name });
      this.arena = pick.arena;
      this.githubRepo = await this.arenaGithub(pick.arena.id).catch(() => undefined);
      this.agentError = undefined;
      this.emit();
    } catch (err) {
      this.showError(err);
    }
  }

  private async setLink(link: Link | undefined, root = this.root): Promise<void> {
    this.link = link;
    await this.ctx.workspaceState.update(LINK_KEY, link);
    if (!root) return;
    const file = path.join(root, '.parallelflow', 'config.json');
    if (link) {
      await ensureParallelFlowDir(root);
      await fsp.writeFile(
        file,
        `${JSON.stringify({ arenaId: link.arenaId, arenaName: link.arenaName }, null, 2)}\n`,
      );
    } else {
      await fsp.rm(file, { force: true });
    }
  }

  async unlinkArena(): Promise<void> {
    await this.setLink(undefined);
    this.arena = undefined;
    this.githubRepo = undefined;
    this.emit();
  }

  async cloneArenaRepo(): Promise<void> {
    if (!(await this.ensureSignedIn())) return;
    let arena = this.arena;
    if (!arena) {
      const arenas = await this.api.arenas().catch((err: unknown) => {
        this.showError(err);
        return [];
      });
      const pick = await vscode.window.showQuickPick(
        arenas.map((a) => ({ label: a.name, arena: a })),
        {
          placeHolder: 'Which arena’s repo?',
        },
      );
      if (!pick) return;
      arena = pick.arena;
    }
    const bundleFile = path.join(os.tmpdir(), `parallelflow-${randomUUID()}.bundle`);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${arena.name} repo…`,
        },
        async () => fsp.writeFile(bundleFile, await this.api.repoBundle(arena.id)),
      );
      const root = this.root;
      if (root && !(await new Git(root).isRepo())) {
        const here = await vscode.window.showInformationMessage(
          `Use the open folder for ${arena.name}? Files already in it are kept.`,
          { modal: true },
          'Use this folder',
          'Clone into a new folder',
        );
        if (!here) return;
        if (here === 'Use this folder') {
          await this.connectFolder(root, arena, bundleFile);
          return;
        }
      }
      if (root && this.link?.arenaId === arena.id && (await new Git(root).isRepo())) {
        await new Git(root).fetchBundle(bundleFile);
        void vscode.window.showInformationMessage(
          `Fetched ${arena.name} into remote-tracking branches parallelflow/*.`,
        );
        return;
      }
      const parent = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        openLabel: 'Clone here',
        title: 'Choose a parent folder for the clone',
      });
      if (!parent?.[0]) return;
      const name = arena.key
        ? arena.key.toLowerCase()
        : arena.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const target = path.join(parent[0].fsPath, name);
      const existing = await fsp.readdir(target).catch(() => undefined);
      if (existing && existing.length > 0) {
        void vscode.window.showErrorMessage(`${target} exists and is not empty.`);
        return;
      }
      await cloneBundle(bundleFile, target);
      await this.setLink({ arenaId: arena.id, arenaName: arena.name }, target);
      const open = await vscode.window.showInformationMessage(
        `Cloned ${arena.name} into ${target}.`,
        'Open folder',
      );
      if (open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
    } catch (err) {
      this.showError(err);
    } finally {
      await fsp.rm(bundleFile, { force: true });
    }
  }

  /** Downloads the arena repo and connects `root` to it in place. False on failure (shown). */
  private async setUpFolder(root: string, arena: { id: string; name: string }): Promise<boolean> {
    const bundleFile = path.join(os.tmpdir(), `parallelflow-${randomUUID()}.bundle`);
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${arena.name} repo…`,
        },
        async () => fsp.writeFile(bundleFile, await this.api.repoBundle(arena.id)),
      );
      return await this.connectFolder(root, arena, bundleFile);
    } catch (err) {
      this.showError(err);
      return false;
    } finally {
      await fsp.rm(bundleFile, { force: true });
    }
  }

  private async connectFolder(
    root: string,
    arena: { id: string; name: string },
    bundleFile: string,
  ): Promise<boolean> {
    try {
      const how = await new Git(root).connectToBundle(bundleFile);
      await this.setLink({ arenaId: arena.id, arenaName: arena.name }, root);
      void vscode.window.showInformationMessage(
        how === 'checked-out'
          ? `This folder now holds the ${arena.name} repo (branch main).`
          : `This folder is connected to the ${arena.name} repo. Your existing files were kept and show as changes.`,
      );
      this.emit();
      return true;
    } catch (err) {
      this.showError(err);
      return false;
    }
  }

  // ---- Building from GitHub (ADR-042) -----------------------------------------------------------

  /** The arena's GitHub repository, or undefined when it has none. */
  private async arenaGithub(projectId: string): Promise<GithubRepo | undefined> {
    const status = await this.api.github(projectId);
    const r = status.repo;
    if (!r || !isGithubCloneUrl(r.clone_url)) return undefined;
    return {
      owner: r.owner,
      name: r.name,
      fullName: r.full_name,
      htmlUrl: r.html_url,
      cloneUrl: r.clone_url,
      defaultBranch: r.default_branch,
    };
  }

  /**
   * The developer's GitHub token from VS Code's built-in GitHub sign-in. Asked for at each use, never
   * stored by ParallelFlow, and only handed to git (environment) and api.github.com.
   */
  private async githubToken(): Promise<string> {
    const session = await vscode.authentication.getSession('github', ['repo'], {
      createIfNone: true,
    });
    return session.accessToken;
  }

  private githubGit(): GithubGit {
    return new GithubGit(() => this.githubToken());
  }

  /** "ParallelFlow: Start building": clone the arena's GitHub repository into a folder. */
  async startBuilding(): Promise<void> {
    if (!(await this.ensureSignedIn())) return;
    try {
      const arenas = await this.api.arenas();
      if (arenas.length === 0) {
        return void vscode.window.showInformationMessage(
          'You are not in any arena yet. Create one on ParallelFlow first.',
        );
      }
      const pick = await vscode.window.showQuickPick(
        arenas.map((a) => ({
          label: a.name,
          description: [a.key, a.stage].filter(Boolean).join(' · '),
          arena: a,
        })),
        { placeHolder: 'Which arena do you want to build?' },
      );
      if (!pick) return;
      const arena = pick.arena;
      const repo = await this.arenaGithub(arena.id);
      if (!repo) {
        const go = await vscode.window.showInformationMessage(
          `${arena.name} is not connected to GitHub, so its repo lives on ParallelFlow. Clone it from there instead?`,
          'Clone arena repo',
        );
        if (go) await this.cloneArenaRepo();
        return;
      }
      const root = this.root;
      if (root && this.link?.arenaId === arena.id && (await new Git(root).isRepo())) {
        this.githubRepo = repo;
        this.emit();
        return void vscode.window.showInformationMessage(
          `This folder already holds ${repo.fullName}. Start a task to build.`,
        );
      }
      const target = await this.chooseEmptyFolder(repo.name);
      if (!target) return;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Cloning ${repo.fullName}…` },
        () => this.githubGit().clone(repo, target),
      );
      await this.setLink({ arenaId: arena.id, arenaName: arena.name }, target);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target));
    } catch (err) {
      this.showError(err);
    }
  }

  /** An empty folder for the clone: picked, or created inside a picked folder. */
  private async chooseEmptyFolder(name: string): Promise<string | undefined> {
    const how = await vscode.window.showQuickPick(
      [
        { label: `Create a new folder "${name}"…`, create: true },
        { label: 'Choose an empty folder…', create: false },
      ],
      { placeHolder: 'Where should the code go?' },
    );
    if (!how) return undefined;
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: how.create ? 'Create it here' : 'Build here',
      title: how.create ? `Choose where to create "${name}"` : 'Choose an empty folder',
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) return undefined;
    const target = how.create ? path.join(dir, name) : dir;
    const existing = await fsp.readdir(target).catch(() => undefined);
    if (existing && existing.length > 0) {
      void vscode.window.showErrorMessage(`${target} is not empty. Choose an empty folder.`);
      return undefined;
    }
    await fsp.mkdir(target, { recursive: true });
    return target;
  }

  /** The stories in docs/product/backlog/ of the clone. */
  private async stories(root: string): Promise<Story[]> {
    const dir = path.join(root, 'docs', 'product', 'backlog');
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    const out: Story[] = [];
    for (const name of names
      .filter((n) => /^story-/i.test(n))
      .sort()
      .slice(0, 300)) {
      const text = await fsp.readFile(path.join(dir, name), 'utf8').catch(() => '');
      const story = parseStory(name, text.slice(0, 4000));
      if (story) out.push(story);
    }
    return out;
  }

  private async startGithubTask(
    root: string,
    repo: GithubRepo,
    title?: string,
    description?: string,
  ): Promise<void> {
    const link = this.link;
    if (!link) return;
    let story: Story | undefined;
    if (!title) {
      const stories = await this.stories(root);
      const pick = await vscode.window.showQuickPick(
        [
          ...stories.map((s) => ({
            label: s.id,
            description: s.title,
            story: s as Story | undefined,
          })),
          { label: '$(edit) Something else…', description: 'Describe the task', story: undefined },
        ],
        { placeHolder: stories.length ? 'Which story?' : 'No stories in docs/product/backlog yet' },
      );
      if (!pick) return;
      story = pick.story;
      if (story) title = story.title;
      else {
        title = await vscode.window.showInputBox({ title: 'Task title', ignoreFocusOut: true });
        if (!title) return;
        description =
          (await vscode.window.showInputBox({
            title: 'What should the agent do?',
            ignoreFocusOut: true,
          })) ?? '';
      }
    }
    if (!(await new Git(root).isClean())) {
      const go = await vscode.window.showWarningMessage(
        'This folder has uncommitted changes. They will come along onto the task branch.',
        { modal: true },
        'Continue',
      );
      if (go !== 'Continue') return;
    }
    const branch = taskBranch(title, story?.id);
    const base = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Fetching ${repo.fullName}…` },
      () => this.githubGit().startBranch(root, repo, branch),
    );
    if (this.task) await this.archiveTask(this.task);
    this.task = {
      id: randomUUID(),
      title: story ? `${story.id}: ${story.title}` : title,
      branch,
      baseSha: base,
      projectId: link.arenaId,
      pushed: false,
      github: {
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
        ...(story && { storyId: story.id, storyPath: story.path }),
      },
    };
    await this.ctx.workspaceState.update(TASK_KEY, this.task);
    this.transcript = new Transcript();
    this.progress?.dispose();
    this.progress = undefined;
    this.emit();

    const rpc = await this.ensureAgent();
    await this.freshSession(rpc);
    const prompt = [
      story ? `Task: implement ${story.id}: ${story.title} (${story.path}).` : `Task: ${title}`,
      description ? `\n${description}` : '',
      `\nYou are on branch ${branch}, created from ${repo.defaultBranch} (${base.slice(0, 10)}) of ${repo.fullName}.`,
      'How to work:',
      ...CODER_REPO_RULES,
      'Start now: read AGENTS.md and docs/design/architecture/, then the story, then plan briefly and work.',
    ].join('\n');
    this.transcript.addUser(this.task.title + (description ? `\n${description}` : ''));
    this.taskRunning = true;
    this.emit();
    await rpc.send({ type: 'prompt', message: prompt, streamingBehavior: 'followUp' });
  }

  /** The project's own checks (package.json typecheck, lint, test), run by the extension. */
  private async runChecks(root: string): Promise<CheckResult[]> {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>;
      };
      scripts = pkg.scripts ?? {};
    } catch {
      return [];
    }
    const exists = (f: string) =>
      fsp.access(path.join(root, f)).then(
        () => true,
        () => false,
      );
    const pm = (await exists('pnpm-lock.yaml'))
      ? 'pnpm'
      : (await exists('yarn.lock'))
        ? 'yarn'
        : 'npm';
    const results: CheckResult[] = [];
    for (const name of ['typecheck', 'lint', 'test'].filter(
      (n) => typeof scripts[n] === 'string',
    )) {
      // A fixed command (no person or repo text in it); the token is not in this environment.
      const cmd = `${pm} run ${name}`;
      const ok = await new Promise<boolean>((resolve) =>
        exec(
          cmd,
          { cwd: root, timeout: 10 * 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
          (err) => resolve(!err),
        ),
      );
      results.push({ name: cmd, status: ok ? 'passed' : 'failed' });
    }
    return results;
  }

  /** Checks, push and the GitHub pull request, as the developer. The agent does none of this. */
  private async openGithubPr(root: string, task: TaskView, repo: GithubRepo): Promise<void> {
    const gh = this.githubGit();
    const subjects = await gh.subjects(root, repo, task.branch);
    if (subjects.length === 0) {
      return void vscode.window.showInformationMessage('The task branch has no commits yet.');
    }
    if (!(await new Git(root).isClean())) {
      const go = await vscode.window.showWarningMessage(
        'There are uncommitted changes. Only commits go into the pull request.',
        { modal: true },
        'Continue',
      );
      if (go !== 'Continue') return;
    }
    const how = await vscode.window.showQuickPick(
      [
        { label: 'Run checks, then open for review', checks: true, draft: false },
        { label: 'Run checks, then open as a draft', checks: true, draft: true },
        { label: 'Open for review without checks', checks: false, draft: false },
      ],
      { placeHolder: `Pull request for ${task.branch} into ${repo.defaultBranch}` },
    );
    if (!how) return;
    const checks = how.checks
      ? await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Running the project checks…' },
          () => this.runChecks(root),
        )
      : [];
    const failed = checks.filter((c) => c.status === 'failed');
    if (failed.length) {
      const go = await vscode.window.showWarningMessage(
        `${failed.map((c) => c.name).join(', ')} failed.`,
        { modal: true, detail: 'The pull request will say so. Open it anyway?' },
        'Open anyway',
      );
      if (go !== 'Open anyway') return;
    } else if (checks.length) {
      void vscode.window.showInformationMessage(
        `Checks passed: ${checks.map((c) => c.name).join(', ')}.`,
      );
    }
    const story: Story | undefined =
      task.github?.storyId && task.github.storyPath
        ? {
            id: task.github.storyId,
            title: task.title.replace(`${task.github.storyId}: `, ''),
            path: task.github.storyPath,
          }
        : undefined;
    const docs = await this.designDocs(root, repo, task.branch);
    const title = pullTitle(task.title, story);
    const body = pullBody({ summary: subjects, story, docs, repo, branch: task.branch, checks });
    const rest = new GithubRest(await this.githubToken());
    const pr = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pushing ${task.branch} to GitHub…`,
      },
      async () => {
        await gh.push(root, repo, task.branch);
        const existing = await rest.findPull(repo, task.branch);
        return existing
          ? rest.updatePull(repo, existing.number, { title, body })
          : rest.createPull(repo, { title, body, head: task.branch, draft: how.draft });
      },
    );
    this.task = { ...task, pushed: true, pr: { number: pr.number, link: pr.html_url } };
    await this.ctx.workspaceState.update(TASK_KEY, this.task);
    this.emit();
    const open = await vscode.window.showInformationMessage(
      `Pull request #${pr.number} is on GitHub. A teammate reviews and merges it there.`,
      'Open on GitHub',
    );
    if (open) await vscode.env.openExternal(vscode.Uri.parse(pr.html_url));
  }

  /** The design docs the work follows: the core architecture files, and those the branch changed. */
  private async designDocs(root: string, repo: GithubRepo, branch: string): Promise<string[]> {
    const core = [
      'AGENTS.md',
      'docs/design/architecture/stack.md',
      'docs/design/architecture/model.yaml',
    ];
    const present: string[] = [];
    for (const f of core) {
      const ok = await fsp.access(path.join(root, ...f.split('/'))).then(
        () => true,
        () => false,
      );
      if (ok) present.push(f);
    }
    const changed = await new Git(root).changedFiles(
      `refs/remotes/origin/${repo.defaultBranch}`,
      branch,
      'docs/design/architecture',
    );
    return [...new Set([...present, ...changed])];
  }

  private async ensureSignedIn(): Promise<boolean> {
    if (await this.token()) return true;
    const pick = await vscode.window.showInformationMessage(
      'Sign in to ParallelFlow first.',
      'Sign in',
    );
    if (pick) await this.signInFlow();
    return Boolean(await this.token());
  }

  // ---- Agent (Layer 1) -------------------------------------------------------------------------

  private async ensureAgent(): Promise<PiRpc> {
    if (this.rpc?.isRunning) return this.rpc;
    const root = this.root;
    if (!root) throw new Error('Open a folder first.');
    const token = await this.token();
    if (!token)
      throw new ParallelFlowAuthError(401, 'NOT_SIGNED_IN', 'Sign in to ParallelFlow first.');
    const cfg = config();
    this.setAgentStatus('starting');

    const version = await new Promise<string>((resolve) =>
      execFile(cfg.nodePath, ['--version'], { timeout: 10_000, windowsHide: true }, (err, out) =>
        resolve(err ? '' : String(out)),
      ),
    );
    if (!nodeVersionOk(version)) {
      throw new Error(
        `The agent needs Node.js 22.19 or newer (found ${version.trim() || 'none'} at "${cfg.nodePath}"). Install it or set parallelflow.nodePath.`,
      );
    }
    const llm = await this.modelChoice(cfg);
    const { router } = llm;

    const parallelflowDir = await ensureParallelFlowDir(root);
    const tmpDir = path.join(parallelflowDir, 'tmp');
    const agentDir = path.join(this.ctx.globalStorageUri.fsPath, 'pi-agent');
    await fsp.mkdir(agentDir, { recursive: true });

    const backend = createVscodeBackend({
      root,
      tmpDir,
      broker: this.broker,
      approvalTimeoutMs: () => config().approvalTimeoutMs,
    });
    this.mcp = await startMcpServer(backend);
    const dist = path.join(this.ctx.extensionPath, 'dist');
    const spec = buildPiLaunch({
      nodePath: cfg.nodePath,
      piCli: cfg.piPath || path.join(dist, 'pi', 'bundle', 'cli.js'),
      guardPath: path.join(dist, 'guard', 'parallelflow-guard.mjs'),
      root,
      agentDir,
      sessionDir: this.sessionDir(root),
      tmpDir,
      agentPath: path.join(dist, 'agent', 'parallelflow-agent.mjs'),
      skillPaths: [
        ...CODER_SKILLS.map((name) => path.join(dist, 'skills', name)),
        ...(await swaFiles(dist, 'skills')),
      ],
      promptPaths: [
        ...CODER_COMMANDS.map((name) => path.join(dist, 'prompts', `${name}.md`)),
        ...(await swaFiles(dist, 'prompts')),
      ],
      agent: {
        agentName: 'AI',
        ...(this.arena && { arenaBrief: arenaBrief(this.arena) }),
        ...(router && { router }),
        ...(llm.claudeToken && router && { provider: CLAUDE_PROVIDER }),
        ...(cfg.mode === 'architect' && { mode: 'architect' as const }),
      },
      provider: router ? PARALLELFLOW_PROVIDER : llm.provider,
      model: router ? AUTO_MODEL : llm.model,
      guard: {
        root,
        allowlist: cfg.allowlist,
        autoApproveEdits: cfg.autoApproveEdits,
        approvalTimeoutMs: cfg.approvalTimeoutMs,
        tmpDir,
        ...(llm.models && { llm: { baseUrl: `${this.api.baseUrl}/v1/llm`, models: llm.models } }),
        mcpUrl: this.mcp.url,
      },
      llmToken: token,
      ...(llm.claudeToken && { claudeToken: llm.claudeToken }),
      mcpToken: this.mcp.token,
      hostEnv: process.env,
    });
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const rpc = new PiRpc(child);
    this.child = child;
    this.rpc = rpc;
    this.model = llm.label;
    rpc.onEvent((e) => {
      if (this.transcript.apply(e)) this.scheduleEmit();
      this.onPiEvent(e);
    });
    rpc.onUiRequest(
      (req) =>
        void handleUiRequest(req, {
          broker: this.broker,
          timeoutMs: config().approvalTimeoutMs,
          respond: (id, response) => rpc.respondUi(id, response),
          notify: (level, message) => {
            this.transcript.notice(level, message);
            this.scheduleEmit();
          },
        }),
    );
    rpc.onExit((err) => {
      if (this.rpc !== rpc) return;
      this.broker.cancelAll('The agent stopped');
      this.rpc = undefined;
      this.child = undefined;
      void this.mcp?.close();
      this.mcp = undefined;
      const expected = this.agentStatus === 'off';
      this.agentError = expected ? undefined : err.message;
      if (!expected) {
        this.transcript.notice(
          'warning',
          'The agent stopped. Your next message picks this chat up again.',
        );
      }
      this.setAgentStatus(expected ? 'off' : 'error');
    });
    await rpc.send({ type: 'get_state' });
    await this.loadChat(rpc);
    this.agentError = undefined;
    this.setAgentStatus('idle');
    return rpc;
  }

  private sessionDir(root: string): string {
    return sessionDirFor(this.ctx.globalStorageUri.fsPath, root);
  }

  /** Show the chat Pi has open (the one it continued or switched to). */
  private async loadChat(rpc: PiRpc): Promise<void> {
    const res = await rpc.send({ type: 'get_messages' });
    const messages = (res.data as { messages?: unknown[] } | undefined)?.messages;
    if (res.success && Array.isArray(messages)) {
      this.transcript.load(messages);
      this.scheduleEmit();
    }
  }

  /** A fresh chat; the current one stays in the earlier chats. */
  async newChat(): Promise<void> {
    try {
      const rpc = await this.ensureAgent();
      await this.freshSession(rpc);
    } catch (err) {
      this.failAgent(err);
    }
  }

  private async freshSession(rpc: PiRpc): Promise<void> {
    const res = await rpc.send({ type: 'new_session' });
    if (!res.success) throw new Error(res.error ?? 'Could not start a new chat.');
    this.broker.cancelAll('A new chat started');
    this.transcript = new Transcript();
    this.emit();
  }

  /** Pick one of this folder's earlier chats and continue it. */
  async resumeChat(): Promise<void> {
    const root = this.root;
    if (!root) return void vscode.window.showWarningMessage('Open a folder first.');
    const sessions = await listSessions(this.sessionDir(root));
    if (!sessions.length) {
      return void vscode.window.showInformationMessage('No earlier chats in this folder yet.');
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: s.title,
        description: new Date(s.modified).toLocaleString(),
        session: s,
      })),
      { placeHolder: 'Continue an earlier chat' },
    );
    if (!pick) return;
    try {
      const rpc = await this.ensureAgent();
      const res = await rpc.send({ type: 'switch_session', sessionPath: pick.session.path });
      if (!res.success) throw new Error(res.error ?? 'Could not open that chat.');
      this.broker.cancelAll('Switched to another chat');
      await this.loadChat(rpc);
    } catch (err) {
      this.failAgent(err);
    }
  }

  private onPiEvent(e: { type: string; [k: string]: unknown }): void {
    if (e.type === 'agent_start') this.setAgentStatus('working');
    if (e.type === 'agent_settled') {
      this.setAgentStatus(this.broker.open.length ? 'waiting' : 'idle');
      if (this.taskRunning && this.task) {
        this.taskRunning = false;
        void this.reportDone();
      }
    }
    if (e.type === 'turn_end' && this.task)
      this.progress?.report('progress', progressSummary(this.transcript.stats));
    if (e.type === 'tool_execution_end' && e.toolName === 'bash' && this.task) {
      const item = this.transcript.items.find((i) => i.kind === 'tool' && i.id === e.toolCallId);
      const command = item && item.kind === 'tool' ? item.summary : '';
      if (isTestCommand(command)) {
        this.progress?.report(
          'tests',
          e.isError ? 'Checks ran and failed; the agent is fixing them.' : 'Checks ran and passed.',
        );
      }
    }
  }

  private async reportDone(): Promise<void> {
    const task = this.task;
    const root = this.root;
    if (!task || !root) return;
    const commits = await new Git(root).commitCount(task.baseSha, task.branch).catch(() => 0);
    this.progress?.report(
      'done',
      `Agent finished this round: ${commits} commit${commits === 1 ? '' : 's'} on ${task.branch}, ${this.transcript.stats.files.size} files changed.`,
    );
  }

  private onApprovalsChanged(open: ApprovalRequest[]): void {
    if (open.length > 0) {
      this.setAgentStatus('waiting');
      if (!this.blockedReported && this.task) {
        this.blockedReported = true;
        this.progress?.report(
          'blocked',
          'Waiting for a teammate to approve a command or answer a question in VS Code.',
        );
      }
      const newest = open[open.length - 1];
      if (newest && !this.sidebar?.visible) void this.modalFallback(newest);
    } else {
      this.blockedReported = false;
      if (this.agentStatus === 'waiting')
        this.setAgentStatus(this.rpc?.isRunning ? 'working' : 'off');
    }
    this.emit();
  }

  /** When the sidebar is hidden, ask in a modal instead (whichever answers first wins). */
  private async modalFallback(req: ApprovalRequest): Promise<void> {
    let answer: ApprovalAnswer | undefined;
    if (req.kind === 'question') {
      const items = [
        ...(req.options ?? []).map((o) => ({ label: o })),
        { label: '$(edit) Type an answer…' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: `The agent asks: ${req.detail}`,
        ignoreFocusOut: true,
      });
      if (!pick) return;
      if (pick.label.startsWith('$(edit)')) {
        const text = await vscode.window.showInputBox({ title: req.detail, ignoreFocusOut: true });
        if (text) answer = { answer: text };
      } else answer = { answer: pick.label };
    } else {
      const detail =
        req.kind === 'command'
          ? `${req.detail}\n\nin ${req.cwd ?? ''}\n\n${req.reason ?? ''}`
          : `${req.detail}\n\n${req.reason ?? ''}`;
      const buttons =
        req.kind === 'command'
          ? ['Approve', 'Approve for this session', 'Deny']
          : ['Approve', 'Deny'];
      const pick = await vscode.window.showWarningMessage(
        req.title,
        { modal: true, detail },
        ...buttons,
      );
      if (!this.broker.get(req.id)) return;
      if (pick === 'Approve') answer = { decision: 'approve' };
      else if (pick === 'Approve for this session') answer = { decision: 'approve_session' };
      else {
        const reason =
          pick === 'Deny'
            ? await vscode.window.showInputBox({ title: 'Reason for the agent (optional)' })
            : undefined;
        answer = { decision: 'deny', reason: reason || undefined };
      }
    }
    if (answer) this.broker.answer(req.id, answer);
  }

  async stopAgent(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc) return;
    await rpc.send({ type: 'abort' }).catch(() => undefined);
    this.broker.cancelAll('Stopped by the person');
    this.taskRunning = false;
  }

  /**
   * The models the agent runs on: the ParallelFlow LLM proxy's (parallelflow.model pins one, otherwise the
   * parallelflow/auto router picks fast or strong per request), or the person's Claude subscription.
   */
  private async modelChoice(cfg: ReturnType<typeof config>): Promise<{
    provider: string;
    model: string;
    router?: AgentRouter;
    label: string;
    models?: LlmModel[];
    claudeToken?: string;
  }> {
    if (cfg.modelSource === 'claude') {
      const claudeToken = await this.ctx.secrets.get(CLAUDE_TOKEN_KEY);
      if (!claudeToken) {
        throw new Error(
          'Connect your Claude subscription first (ParallelFlow: Connect Claude Subscription), or set parallelflow.modelSource to "parallelflow".',
        );
      }
      return cfg.model
        ? {
            provider: CLAUDE_PROVIDER,
            model: cfg.model,
            label: `Claude · ${cfg.model}`,
            claudeToken,
          }
        : {
            provider: CLAUDE_PROVIDER,
            model: AUTO_MODEL,
            router: CLAUDE_ROUTER,
            label: 'Claude subscription · auto',
            claudeToken,
          };
    }
    const models: LlmModel[] = await this.api.llmModels();
    if (models.length === 0) throw new Error('ParallelFlow offers no models for coding yet.');
    const router = cfg.model ? undefined : routerFrom(models);
    const model = models.find((m) => m.id === cfg.model) ?? models[0];
    if (!model) throw new Error('No model available.');
    return {
      provider: PARALLELFLOW_PROVIDER,
      model: model.id,
      ...(router && { router }),
      label: router ? 'ParallelFlow auto' : model.name,
      models,
    };
  }

  /** Store a `claude setup-token` token and run the agent on the person's Claude subscription. */
  async connectClaude(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Connect your Claude subscription',
      prompt:
        "Run `claude setup-token` in a terminal (Claude Pro or Max), then paste the token here. It stays in VS Code's secret storage on this computer.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-oat01-…',
      validateInput: (v) => {
        const parsed = claudeTokenFrom(v);
        return 'error' in parsed ? parsed.error : undefined;
      },
    });
    const parsed = value ? claudeTokenFrom(value) : undefined;
    if (!parsed || !('token' in parsed)) return;
    await this.ctx.secrets.store(CLAUDE_TOKEN_KEY, parsed.token);
    const c = vscode.workspace.getConfiguration('parallelflow');
    if (c.get<string>('modelSource', 'parallelflow') !== 'claude') {
      // onDidChangeConfiguration restarts the agent on the subscription.
      await c.update('modelSource', 'claude', vscode.ConfigurationTarget.Global);
    } else if (this.rpc) {
      await this.restartAgent();
    }
    void vscode.window.showInformationMessage(
      'The coding agent now runs on your Claude subscription.',
    );
  }

  async disconnectClaude(): Promise<void> {
    await this.ctx.secrets.delete(CLAUDE_TOKEN_KEY);
    const c = vscode.workspace.getConfiguration('parallelflow');
    if (c.get<string>('modelSource', 'parallelflow') === 'claude') {
      await c.update('modelSource', 'parallelflow', vscode.ConfigurationTarget.Global);
    } else if (this.rpc) {
      await this.restartAgent();
    }
    void vscode.window.showInformationMessage(
      'Claude subscription disconnected. The coding agent uses ParallelFlow models.',
    );
  }

  async restartAgent(): Promise<void> {
    await this.shutdownAgent();
    try {
      await this.ensureAgent();
    } catch (err) {
      this.failAgent(err);
    }
  }

  async shutdownAgent(): Promise<void> {
    this.setAgentStatus('off');
    this.broker.cancelAll('The agent stopped');
    this.rpc?.stop();
    this.rpc = undefined;
    this.child = undefined;
    await this.mcp?.close();
    this.mcp = undefined;
  }

  private failAgent(err: unknown): void {
    this.agentError = err instanceof Error ? err.message : String(err);
    this.setAgentStatus('error');
    if (err instanceof ParallelFlowAuthError) void this.handleUnauthorized();
  }

  async sendPrompt(text: string): Promise<void> {
    try {
      const rpc = await this.ensureAgent();
      this.transcript.addUser(text);
      this.emit();
      await rpc.send({ type: 'prompt', message: text, streamingBehavior: 'steer' });
    } catch (err) {
      this.failAgent(err);
    }
  }

  // ---- Tasks, push, PR -------------------------------------------------------------------------

  async startTask(title?: string, description?: string): Promise<void> {
    const root = this.root;
    if (!root) return void vscode.window.showWarningMessage('Open a folder first.');
    if (!(await this.ensureSignedIn())) return;
    if (!this.link) {
      await this.linkArena();
      if (!this.link) return;
    }
    const projectId = this.link.arenaId;
    const arenaName = this.link.arenaName;
    const repo = this.githubRepo ?? (await this.arenaGithub(projectId).catch(() => undefined));
    if (repo) {
      this.githubRepo = repo;
      if (!(await new Git(root).isRepo())) {
        const go = await vscode.window.showInformationMessage(
          `${arenaName} builds from GitHub (${repo.fullName}). Clone it into a new folder first.`,
          'Start building',
        );
        if (go) await this.startBuilding();
        return;
      }
      try {
        await this.startGithubTask(root, repo, title, description);
      } catch (err) {
        this.failAgent(err);
        this.showError(err);
      }
      return;
    }
    if (!title) {
      title = await vscode.window.showInputBox({ title: 'Task title', ignoreFocusOut: true });
      if (!title) return;
      description =
        (await vscode.window.showInputBox({
          title: 'What should the agent do?',
          ignoreFocusOut: true,
        })) ?? '';
    }
    const git = new Git(root);
    try {
      if (!(await git.isRepo())) {
        const choice = await vscode.window.showInformationMessage(
          `Set up this folder for ${arenaName}? ParallelFlow will connect it to the arena's git repo here. Files already in the folder are kept.`,
          { modal: true },
          'Set up this folder',
        );
        if (choice !== 'Set up this folder') return;
        if (!(await this.setUpFolder(root, { id: projectId, name: arenaName }))) return;
      }
      if (!(await git.isClean())) {
        const go = await vscode.window.showWarningMessage(
          'This folder has uncommitted changes. They will come along onto the task branch.',
          { modal: true },
          'Continue',
        );
        if (go !== 'Continue') return;
      }
      const session = await this.api.startCodingSession(projectId, {
        title,
        description: description ?? '',
      });
      try {
        await git.checkoutTaskBranch(session.branch, session.base_sha);
      } catch (err) {
        if (!(await git.hasCommit(session.base_sha))) {
          const bundle = path.join(os.tmpdir(), `parallelflow-${randomUUID()}.bundle`);
          try {
            await fsp.writeFile(bundle, await this.api.repoBundle(projectId));
            await git.fetchBundle(bundle);
          } finally {
            await fsp.rm(bundle, { force: true });
          }
          await git.checkoutTaskBranch(session.branch, session.base_sha);
        } else throw err;
      }
      if (this.task) await this.archiveTask(this.task);
      this.task = {
        id: session.id,
        title,
        branch: session.branch,
        baseSha: session.base_sha,
        projectId,
        pushed: false,
      };
      await this.ctx.workspaceState.update(TASK_KEY, this.task);
      this.transcript = new Transcript();
      this.progress?.dispose();
      this.progress = new ProgressReporter(
        (e) => this.api.postEvent(projectId, session.id, e),
        30_000,
        undefined,
        () => undefined,
      );
      this.emit();

      const rpc = await this.ensureAgent();
      await this.freshSession(rpc);
      const prompt = [
        `Task: ${title}`,
        description ? `\n${description}` : '',
        `\nYou are on branch ${session.branch}, created from ${session.base_sha.slice(0, 10)}. Commit your work to this branch in small commits with clear messages. Do not switch branches, do not touch main, do not push.`,
        'Start by reading .parallelflow/architecture.md if it exists (or call the architecture tool), then plan briefly and work.',
      ].join('\n');
      this.transcript.addUser(`Task: ${title}${description ? `\n${description}` : ''}`);
      this.taskRunning = true;
      this.emit();
      this.progress.report('progress', `Started on branch ${session.branch}.`);
      await rpc.send({ type: 'prompt', message: prompt, streamingBehavior: 'followUp' });
    } catch (err) {
      this.failAgent(err);
      this.showError(err);
    }
  }

  private async archiveTask(task: TaskView): Promise<void> {
    const history = this.ctx.workspaceState.get<ViewState['history']>(HISTORY_KEY, []);
    history.unshift({ title: task.title, branch: task.branch, pr: task.pr?.number });
    await this.ctx.workspaceState.update(HISTORY_KEY, history.slice(0, 20));
  }

  async pushBranch(): Promise<void> {
    const task = this.task;
    const root = this.root;
    if (!task || !root) return void vscode.window.showInformationMessage('Start a task first.');
    if (task.github) {
      const repo = this.githubRepo;
      if (!repo) return void this.showError(new Error('GitHub is not reachable for this arena.'));
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Pushing ${task.branch} to GitHub…`,
          },
          () => this.githubGit().push(root, repo, task.branch),
        );
        this.task = { ...task, pushed: true };
        await this.ctx.workspaceState.update(TASK_KEY, this.task);
        this.emit();
      } catch (err) {
        this.showError(err);
      }
      return;
    }
    const git = new Git(root);
    const file = path.join(os.tmpdir(), `parallelflow-push-${randomUUID()}.bundle`);
    try {
      const commits = await git.commitCount(task.baseSha, task.branch);
      if (commits === 0)
        return void vscode.window.showInformationMessage('The task branch has no commits yet.');
      if (!(await git.isClean())) {
        const go = await vscode.window.showWarningMessage(
          'There are uncommitted changes. Only commits are pushed.',
          { modal: true },
          'Push commits',
        );
        if (go !== 'Push commits') return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pushing ${task.branch} to ParallelFlow…`,
        },
        async () => {
          await git.bundleBranch(task.branch, task.baseSha, file);
          const bytes = await fsp.readFile(file);
          await this.api.push(task.projectId, task.id, bytes);
        },
      );
      this.progress?.flush();
      this.task = { ...task, pushed: true };
      await this.ctx.workspaceState.update(TASK_KEY, this.task);
      this.emit();
      void vscode.window.showInformationMessage(
        `Pushed ${commits} commit${commits === 1 ? '' : 's'} on ${task.branch}.`,
      );
    } catch (err) {
      this.showError(err);
    } finally {
      await fsp.rm(file, { force: true });
    }
  }

  async openPr(): Promise<void> {
    const task = this.task;
    if (!task) return void vscode.window.showInformationMessage('Start a task first.');
    if (task.github) {
      const root = this.root;
      const repo = this.githubRepo;
      if (!root || !repo) {
        return void this.showError(new Error('GitHub is not reachable for this arena.'));
      }
      try {
        await this.openGithubPr(root, task, repo);
      } catch (err) {
        this.showError(err);
      }
      return;
    }
    if (!task.pushed) return void vscode.window.showInformationMessage('Push the branch first.');
    const title = await vscode.window.showInputBox({
      title: 'Pull request title',
      value: task.title,
      ignoreFocusOut: true,
    });
    if (!title) return;
    const description =
      (await vscode.window.showInputBox({
        title: 'Description (optional)',
        ignoreFocusOut: true,
      })) ?? '';
    try {
      const pr = await this.api.openPull(task.projectId, {
        coding_session_id: task.id,
        title,
        description,
      });
      const link = this.api.pullUrl(task.projectId, pr.number);
      this.task = { ...task, pr: { number: pr.number, link } };
      await this.ctx.workspaceState.update(TASK_KEY, this.task);
      this.emit();
      const open = await vscode.window.showInformationMessage(
        `Opened PR #${pr.number}.`,
        'Open in ParallelFlow',
      );
      if (open) await vscode.env.openExternal(vscode.Uri.parse(link));
    } catch (err) {
      this.showError(err);
    }
  }

  // ---- Misc commands ---------------------------------------------------------------------------

  async refreshArchitecture(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const tmpDir = path.join(await ensureParallelFlowDir(root), 'tmp');
    const backend = createVscodeBackend({
      root,
      tmpDir,
      broker: this.broker,
      approvalTimeoutMs: () => config().approvalTimeoutMs,
    });
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'ParallelFlow: summarising architecture' },
      () => refreshArchitecture(backend),
    );
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(root, '.parallelflow', 'architecture.md')),
      { preview: true },
    );
  }

  async reopenInContainer(): Promise<void> {
    await reopenInContainer();
  }

  async scaffoldDevContainer(): Promise<void> {
    const root = this.root;
    if (!root) return;
    const uri = await scaffoldDevContainer(root);
    if (uri) await vscode.window.showTextDocument(uri);
    this.isolation = await detectIsolation(root);
    this.emit();
  }

  handleMessage(m: FromWebview): void {
    switch (m.type) {
      case 'ready':
        this.emit();
        return;
      case 'command': {
        const map: Record<typeof m.command, () => Promise<void> | void> = {
          signIn: () => this.signInFlow(),
          signOut: () => this.signOut(),
          cancelSignIn: () => this.cancelSignIn(),
          linkArena: () => this.linkArena(),
          cloneArenaRepo: () => this.cloneArenaRepo(),
          startBuilding: () => this.startBuilding(),
          stopAgent: () => this.stopAgent(),
          restartAgent: () => this.restartAgent(),
          newChat: () => this.newChat(),
          resumeChat: () => this.resumeChat(),
          pushBranch: () => this.pushBranch(),
          openPr: () => this.openPr(),
          reopenInContainer: () => this.reopenInContainer(),
          scaffoldDevContainer: () => this.scaffoldDevContainer(),
          refreshArchitecture: () => this.refreshArchitecture(),
          switchMode: () => this.switchMode(),
        };
        void Promise.resolve(map[m.command]()).catch((err: unknown) => this.showError(err));
        return;
      }
      case 'startTask':
        void this.startTask(m.title, m.description);
        return;
      case 'prompt':
        void this.sendPrompt(m.text);
        return;
      case 'decision':
        this.broker.answer(m.id, { decision: m.decision, reason: m.reason });
        return;
      case 'answer':
        this.broker.answer(m.id, { answer: m.answer });
        return;
      case 'approveGate':
        void this.approveGate(m.gate);
        return;
      case 'openArch':
        void this.openArch(m.path);
        return;
      case 'openUrl':
        if (/^https?:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
    }
  }

  // ---- Architect mode (SWA, packages/pi-swa) --------------------------------------------------

  async switchMode(): Promise<void> {
    const next: AgentMode = config().mode === 'architect' ? 'coder' : 'architect';
    // onDidChangeConfiguration restarts the agent in the new mode.
    await vscode.workspace
      .getConfiguration('parallelflow')
      .update('mode', next, vscode.ConfigurationTarget.Workspace);
  }

  private async onModeChanged(): Promise<void> {
    if (this.rpc) await this.restartAgent();
    this.emit();
  }

  /** The person's approval of a gate: confirmed here, then run by the SWA command in Pi. */
  private async approveGate(gate: string): Promise<void> {
    if (!/^G[0-3](:CMP-\d{1,4})?$/.test(gate)) return;
    const files = this.architect.view?.gates.find((g) => g.key === gate)?.files ?? [];
    const pick = await vscode.window.showInformationMessage(
      `Approve ${gate}?`,
      {
        modal: true,
        detail: `You approve ${files.map((f) => `arch/${f.path}`).join(', ') || 'its files'} as they are now. The next phase can start; any later edit reopens the gate.`,
      },
      'Approve',
    );
    if (pick !== 'Approve') return;
    await this.sendPrompt(`/swa approve ${gate}`);
  }

  private async openArch(rel: string): Promise<void> {
    const root = this.root;
    const uri = root ? archFile(root, rel) : undefined;
    if (uri) await vscode.commands.executeCommand('vscode.open', uri);
  }

  // ---- View ------------------------------------------------------------------------------------

  private setAgentStatus(status: AgentStatus): void {
    this.agentStatus = status;
    this.emit();
  }

  private scheduleEmit(): void {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit();
    }, 60);
  }

  private emit(): void {
    const labels: Record<AgentStatus, string> = {
      off: '$(circle-outline) ParallelFlow',
      starting: '$(sync~spin) ParallelFlow: starting',
      idle: '$(check) ParallelFlow: ready',
      working: '$(sync~spin) ParallelFlow: working',
      waiting: '$(bell-dot) ParallelFlow: needs you',
      error: '$(error) ParallelFlow: error',
    };
    this.status.text = labels[this.agentStatus];
    this.status.tooltip = `${this.isolation === 'container' ? 'Isolated (Dev Container)' : 'Host — commands need approval'}${this.model ? ` · ${this.model}` : ''}`;
    void this.token().then((token) => {
      const state: ViewState = {
        parallelflowUrl: config().url,
        signedIn: Boolean(token),
        user: token ? this.user : undefined,
        signIn: this.signIn ? { userCode: this.signIn.userCode, uri: this.signIn.uri } : undefined,
        folder: this.root,
        arena: this.arena
          ? {
              id: this.arena.id,
              name: this.arena.name,
              key: this.arena.key,
              stage: this.arena.stage,
              cycle: this.arena.cycle,
            }
          : this.link
            ? {
                id: this.link.arenaId,
                name: this.link.arenaName,
                key: '',
                stage: null,
                cycle: null,
              }
            : undefined,
        ...(this.githubRepo && { githubRepo: this.githubRepo.fullName }),
        isolation: this.isolation,
        agent: { status: this.agentStatus, model: this.model, error: this.agentError },
        mode: config().mode,
        ...(this.architect.view && { architecture: this.architect.view }),
        task: this.task,
        history: this.ctx.workspaceState.get<ViewState['history']>(HISTORY_KEY, []),
        transcript: this.transcript.items,
        approvals: this.broker.open,
      };
      this.sidebar?.post(state);
    });
  }

  private showError(err: unknown): void {
    const message =
      err instanceof ParallelFlowApiError || err instanceof Error
        ? err.message
        : 'Something went wrong';
    void vscode.window.showErrorMessage(`ParallelFlow: ${message}`);
  }

  dispose(): void {
    void this.shutdownAgent();
    this.progress?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
