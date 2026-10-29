// ParallelFlow for VS Code: entry point. Registers the chat (sidebar and editor tab), the Arena tree,
// commands and the "Build in VS Code" link handler.
import * as vscode from 'vscode';
import { ParallelFlowController } from './controller.js';
import { parseStartLink } from './parallelflow/start-link.js';
import { ArenaTree, gateOf } from './ui/arena-tree.js';
import { ChatHub } from './ui/sidebar.js';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ParallelFlowController(context);
  const chat = new ChatHub(context.extensionUri, (m, reply) => controller.handleMessage(m, reply));
  const arenaTree = new ArenaTree();
  controller.attachViews(chat, arenaTree);

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'parallelflow.signIn': () => controller.signInFlow(),
    'parallelflow.signOut': () => controller.signOut(),
    'parallelflow.linkArena': () => controller.linkArena(),
    'parallelflow.unlinkArena': () => controller.unlinkArena(),
    'parallelflow.cloneArenaRepo': () => controller.cloneArenaRepo(),
    'parallelflow.startBuilding': () => controller.startBuilding(),
    'parallelflow.startTask': () => controller.startTask(),
    'parallelflow.stopAgent': () => controller.stopAgent(),
    'parallelflow.restartAgent': () => controller.restartAgent(),
    'parallelflow.newChat': () => controller.newChat(),
    'parallelflow.resumeChat': () => controller.resumeChat(),
    'parallelflow.pushBranch': () => controller.pushBranch(),
    'parallelflow.openPr': () => controller.openPr(),
    'parallelflow.refreshArchitecture': () => controller.refreshArchitecture(),
    'parallelflow.reopenInContainer': () => controller.reopenInContainer(),
    'parallelflow.scaffoldDevContainer': () => controller.scaffoldDevContainer(),
    'parallelflow.switchMode': () => controller.switchMode(),
    'parallelflow.connectClaude': () => controller.connectClaude(),
    'parallelflow.disconnectClaude': () => controller.disconnectClaude(),
    'parallelflow.focusChat': () => controller.focusChat(),
    'parallelflow.openChatTab': () => controller.openChatTab(),
    'parallelflow.addSelectionToChat': () => controller.addSelectionToChat(),
    // Arena tree actions.
    'parallelflow.approveGate': (arg) => {
      const gate = gateOf(arg);
      if (gate) return controller.approveGate(gate);
    },
    'parallelflow.openArchFile': (rel) => {
      if (typeof rel === 'string') return controller.openArch(rel);
    },
    'parallelflow.openExternal': (url) => controller.openExternal(url),
  };
  context.subscriptions.push(
    controller,
    chat,
    arenaTree,
    vscode.window.registerWebviewViewProvider(ChatHub.viewId, chat.sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.createTreeView(ArenaTree.viewId, { treeDataProvider: arenaTree }),
    ...Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(id, fn)),
    // "Build in VS Code" on the arena page: vscode://<publisher>.<name>/start?arena=…&code=…&web=…
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path !== '/start') return;
        const url = vscode.workspace.getConfiguration('parallelflow').get<string>('url', '');
        const link = parseStartLink(uri.query, url || 'http://localhost:3000');
        if (!link) {
          void vscode.window.showErrorMessage('That ParallelFlow link is not valid.');
          return;
        }
        void controller.openFromLink(link);
      },
    }),
  );
}

export function deactivate(): void {
  // The controller is disposed through context.subscriptions (stops Pi and the MCP server).
}
