// Saras for VS Code: entry point. Registers the sidebar, commands and status bar.
import * as vscode from 'vscode';
import { SarasController } from './controller.js';
import { SidebarProvider } from './ui/sidebar.js';

export function activate(context: vscode.ExtensionContext): void {
  const controller = new SarasController(context);
  const sidebar = new SidebarProvider(context.extensionUri, (m) => controller.handleMessage(m));
  controller.attachSidebar(sidebar);

  const commands: Record<string, () => unknown> = {
    'saras.signIn': () => controller.signInFlow(),
    'saras.signOut': () => controller.signOut(),
    'saras.linkArena': () => controller.linkArena(),
    'saras.unlinkArena': () => controller.unlinkArena(),
    'saras.cloneArenaRepo': () => controller.cloneArenaRepo(),
    'saras.startTask': () => controller.startTask(),
    'saras.stopAgent': () => controller.stopAgent(),
    'saras.restartAgent': () => controller.restartAgent(),
    'saras.newChat': () => controller.newChat(),
    'saras.resumeChat': () => controller.resumeChat(),
    'saras.pushBranch': () => controller.pushBranch(),
    'saras.openPr': () => controller.openPr(),
    'saras.refreshArchitecture': () => controller.refreshArchitecture(),
    'saras.reopenInContainer': () => controller.reopenInContainer(),
    'saras.scaffoldDevContainer': () => controller.scaffoldDevContainer(),
    'saras.switchMode': () => controller.switchMode(),
    'saras.connectClaude': () => controller.connectClaude(),
    'saras.disconnectClaude': () => controller.disconnectClaude(),
  };
  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewId, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    ...Object.entries(commands).map(([id, fn]) => vscode.commands.registerCommand(id, fn)),
  );
}

export function deactivate(): void {
  // The controller is disposed through context.subscriptions (stops Pi and the MCP server).
}
