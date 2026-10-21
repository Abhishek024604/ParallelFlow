// Ties the three layers together for one VS Code window: Saras sign-in and arena link, the Pi agent
// process (Layer 1) with saras-guard, the codebase MCP server (Layer 2), and the sidebar, status
// bar and approval prompts (Layer 3).
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { type ApprovalAnswer, ApprovalBroker, type ApprovalRequest } from './approvals/broker.js';
import { handleUiRequest } from './approvals/ui-bridge.js';
import { type RunningMcpServer, startMcpServer } from './intel/mcp-server.js';
import { refreshArchitecture } from './intel/tools.js';
import { createVscodeBackend, ensureSarasDir } from './intel/vscode-backend.js';
import { buildPiLaunch, nodeVersionOk } from './pi/launcher.js';
import {
  arenaBrief,
  type AgentMode,
  AUTO_MODEL,
  CODER_COMMANDS,
  CODER_SKILLS,
  routerFrom,
} from './shared/agent-config.js';
import { PiRpc } from './pi/rpc.js';
import { Transcript } from './pi/transcript.js';
import { type Arena, type LlmModel, SarasApi, SarasApiError, SarasAuthError } from './saras/api.js';
import { DeviceFlowError, runDeviceFlow } from './saras/device-flow.js';
import { cloneBundle, Git } from './saras/git.js';
import { isTestCommand, ProgressReporter, progressSummary } from './saras/progress.js';
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

const TOKEN_KEY = 'saras.token';
const USER_KEY = 'saras.user';
const LINK_KEY = 'saras.link';
const TASK_KEY = 'saras.task';
const HISTORY_KEY = 'saras.history';

interface StoredToken {
  token: string;
  expiresAt: number;
}
interface Link {
  arenaId: string;
  arenaName: string;
}

function config() {
  const c = vscode.workspace.getConfiguration('saras');
  return {
    url: c.get<string>('url', 'http://localhost:3000'),
    allowlist: c.get<string[]>('commandAllowlist', []),
    autoApproveEdits: c.get<boolean>('autoApproveEdits', true),
    approvalTimeoutMs: Math.max(10, c.get<number>('approvalTimeoutSeconds', 300)) * 1000,
    nodePath: c.get<string>('nodePath', 'node') || 'node',
    piPath: c.get<string>('piPath', ''),
    model: c.get<string>('model', ''),
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

export class SarasController implements vscode.Disposable {
  readonly broker = new ApprovalBroker();
  private transcript = new Transcript();
  private sidebar: SidebarProvider | undefined;
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private api: SarasApi;
  private user: { displayName: string; email: string } | undefined;
  private signIn: { userCode: string; uri: string; abort: AbortController } | undefined;
  private arena: Arena | undefined;
  private link: Link | undefined;
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
    this.status.command = 'saras.sidebar.focus';
    this.status.show();
    this.user = ctx.globalState.get(USER_KEY);
    this.link = ctx.workspaceState.get<Link>(LINK_KEY);
    this.task = ctx.workspaceState.get<TaskView>(TASK_KEY);
    this.disposables.push(
      this.status,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('saras.url')) {
          this.api = this.makeApi();
          this.emit();
        }
        if (e.affectsConfiguration('saras.mode')) void this.onModeChanged();
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

  private makeApi(): SarasApi {
    return new SarasApi({
      baseUrl: config().url,
      getToken: () => this.token(),
      onUnauthorized: () => void this.handleUnauthorized(),
    });
  }

  private async init(): Promise<void> {
    this.isolation = await detectIsolation(this.root);
    if (config().mode === 'architect') await this.architect.watch(this.root);
    if (!this.link && this.root) {
      // A folder cloned or linked before keeps its arena in .saras/config.json.
      try {
        const raw = JSON.parse(
          await fsp.readFile(path.join(this.root, '.saras', 'config.json'), 'utf8'),
        ) as Partial<Link>;
        if (typeof raw.arenaId === 'string' && typeof raw.arenaName === 'string') {
          this.link = { arenaId: raw.arenaId, arenaName: raw.arenaName };
          await this.ctx.workspaceState.update(LINK_KEY, this.link);
        }
      } catch {
        // not linked
      }
    }
    if (await this.token()) await this.refreshArena();
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
      void vscode.window.showInformationMessage(`Signed in to Saras as ${this.user.displayName}.`);
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
    const pick = await vscode.window.showWarningMessage('Your Saras sign-in expired.', 'Sign in');
    if (pick) await this.signInFlow();
  }

  // ---- Arena link ------------------------------------------------------------------------------

  private async refreshArena(): Promise<void> {
    if (!this.link) {
      this.arena = undefined;
      return;
    }
    try {
      const arenas = await this.api.arenas();
      this.arena = arenas.find((a) => a.id === this.link?.arenaId);
      if (!this.arena) this.agentError = `You are no longer a member of ${this.link.arenaName}.`;
    } catch (err) {
      if (!(err instanceof SarasAuthError)) this.agentError = (err as Error).message;
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
          'You are not in any arena yet. Create one on Saras first.',
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
    const file = path.join(root, '.saras', 'config.json');
    if (link) {
      await ensureSarasDir(root);
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
    const bundleFile = path.join(os.tmpdir(), `saras-${randomUUID()}.bundle`);
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
          `Fetched ${arena.name} into remote-tracking branches saras/*.`,
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
    const bundleFile = path.join(os.tmpdir(), `saras-${randomUUID()}.bundle`);
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

  private async ensureSignedIn(): Promise<boolean> {
    if (await this.token()) return true;
    const pick = await vscode.window.showInformationMessage('Sign in to Saras first.', 'Sign in');
    if (pick) await this.signInFlow();
    return Boolean(await this.token());
  }

  // ---- Agent (Layer 1) -------------------------------------------------------------------------

  private async ensureAgent(): Promise<PiRpc> {
    if (this.rpc?.isRunning) return this.rpc;
    const root = this.root;
    if (!root) throw new Error('Open a folder first.');
    const token = await this.token();
    if (!token) throw new SarasAuthError(401, 'NOT_SIGNED_IN', 'Sign in to Saras first.');
    const cfg = config();
    this.setAgentStatus('starting');

    const version = await new Promise<string>((resolve) =>
      execFile(cfg.nodePath, ['--version'], { timeout: 10_000, windowsHide: true }, (err, out) =>
        resolve(err ? '' : String(out)),
      ),
    );
    if (!nodeVersionOk(version)) {
      throw new Error(
        `The agent needs Node.js 22.19 or newer (found ${version.trim() || 'none'} at "${cfg.nodePath}"). Install it or set saras.nodePath.`,
      );
    }
    const models: LlmModel[] = await this.api.llmModels();
    if (models.length === 0) throw new Error('Saras offers no models for coding yet.');
    // saras.model pins one model; otherwise saras-agent's router picks fast or strong per request.
    const router = cfg.model ? undefined : routerFrom(models);
    const model = models.find((m) => m.id === cfg.model) ?? models[0];
    if (!model) throw new Error('No model available.');

    const sarasDir = await ensureSarasDir(root);
    const tmpDir = path.join(sarasDir, 'tmp');
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
      guardPath: path.join(dist, 'guard', 'saras-guard.mjs'),
      root,
      agentDir,
      tmpDir,
      agentPath: path.join(dist, 'agent', 'saras-agent.mjs'),
      skillPaths: [
        ...CODER_SKILLS.map((name) => path.join(dist, 'skills', name)),
        ...(cfg.mode === 'architect' ? await swaFiles(dist, 'skills') : []),
      ],
      promptPaths: [
        ...CODER_COMMANDS.map((name) => path.join(dist, 'prompts', `${name}.md`)),
        ...(cfg.mode === 'architect' ? await swaFiles(dist, 'prompts') : []),
      ],
      agent: {
        agentName: 'AI',
        ...(this.arena && { arenaBrief: arenaBrief(this.arena) }),
        ...(router && { router }),
        ...(cfg.mode === 'architect' && { mode: 'architect' as const }),
      },
      model: router ? AUTO_MODEL : model.id,
      guard: {
        root,
        allowlist: cfg.allowlist,
        autoApproveEdits: cfg.autoApproveEdits,
        approvalTimeoutMs: cfg.approvalTimeoutMs,
        tmpDir,
        llm: { baseUrl: `${this.api.baseUrl}/v1/llm`, models },
        mcpUrl: this.mcp.url,
      },
      llmToken: token,
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
    this.model = router ? 'Saras auto' : model.name;
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
      this.setAgentStatus(expected ? 'off' : 'error');
    });
    await rpc.send({ type: 'get_state' });
    this.agentError = undefined;
    this.setAgentStatus('idle');
    return rpc;
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
    if (err instanceof SarasAuthError) void this.handleUnauthorized();
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
          `Set up this folder for ${arenaName}? Saras will connect it to the arena's git repo here. Files already in the folder are kept.`,
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
          const bundle = path.join(os.tmpdir(), `saras-${randomUUID()}.bundle`);
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
      const prompt = [
        `Task: ${title}`,
        description ? `\n${description}` : '',
        `\nYou are on branch ${session.branch}, created from ${session.base_sha.slice(0, 10)}. Commit your work to this branch in small commits with clear messages. Do not switch branches, do not touch main, do not push.`,
        'Start by reading .saras/architecture.md if it exists (or call the architecture tool), then plan briefly and work.',
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
    const git = new Git(root);
    const file = path.join(os.tmpdir(), `saras-push-${randomUUID()}.bundle`);
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
          title: `Pushing ${task.branch} to Saras…`,
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
        'Open in Saras',
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
    const tmpDir = path.join(await ensureSarasDir(root), 'tmp');
    const backend = createVscodeBackend({
      root,
      tmpDir,
      broker: this.broker,
      approvalTimeoutMs: () => config().approvalTimeoutMs,
    });
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Saras: summarising architecture' },
      () => refreshArchitecture(backend),
    );
    await vscode.window.showTextDocument(
      vscode.Uri.file(path.join(root, '.saras', 'architecture.md')),
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
          stopAgent: () => this.stopAgent(),
          restartAgent: () => this.restartAgent(),
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
      .getConfiguration('saras')
      .update('mode', next, vscode.ConfigurationTarget.Workspace);
  }

  private async onModeChanged(): Promise<void> {
    await this.architect.watch(config().mode === 'architect' ? this.root : undefined);
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
      off: '$(circle-outline) Saras',
      starting: '$(sync~spin) Saras: starting',
      idle: '$(check) Saras: ready',
      working: '$(sync~spin) Saras: working',
      waiting: '$(bell-dot) Saras: needs you',
      error: '$(error) Saras: error',
    };
    this.status.text = labels[this.agentStatus];
    this.status.tooltip = `${this.isolation === 'container' ? 'Isolated (Dev Container)' : 'Host — commands need approval'}${this.model ? ` · ${this.model}` : ''}`;
    void this.token().then((token) => {
      const state: ViewState = {
        sarasUrl: config().url,
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
        isolation: this.isolation,
        agent: { status: this.agentStatus, model: this.model, error: this.agentError },
        mode: config().mode,
        ...(config().mode === 'architect' &&
          this.architect.view && {
            architecture: this.architect.view,
          }),
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
      err instanceof SarasApiError || err instanceof Error ? err.message : 'Something went wrong';
    void vscode.window.showErrorMessage(`Saras: ${message}`);
  }

  dispose(): void {
    void this.shutdownAgent();
    this.progress?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
