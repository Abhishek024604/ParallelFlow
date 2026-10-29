// ParallelFlow for VS Code: entry point. Registers the sidebar, commands and status bar.
import * as vscode from 'vscode';
import { ParallelFlowController } from './controller.js';
import { parseStartLink } from './parallelflow/start-link.js';
import { SidebarProvider } from './ui/sidebar.js';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new ParallelFlowController(context);
  const sidebar = new SidebarProvider(context.extensionUri, (m) => controller.handleMessage(m));
  controller.attachSidebar(sidebar);

  const commands: Record<string, () => unknown> = {
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
  };
  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
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
