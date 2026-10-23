// The ParallelFlow sidebar: a webview view with a strict CSP (nonce scripts, no inline handlers, no remote
// content) styled only with VS Code theme variables, so it matches light, dark and high contrast.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromWebview, ToWebview, ViewState } from '../shared/messages.js';

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'parallelflow.sidebar';
  private view: vscode.WebviewView | undefined;
  private last: ViewState | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (m: FromWebview) => void,
  ) {}

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = this.html(view.webview, dist);
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'ready' && this.last) this.post(this.last);
      this.onMessage(m);
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  post(state: ViewState): void {
    this.last = state;
    const message: ToWebview = { type: 'state', state };
    void this.view?.webview.postMessage(message);
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand(`${SidebarProvider.viewId}.focus`);
  }

  private html(webview: vscode.Webview, dist: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style.toString()}">
<title>ParallelFlow</title>
</head>
<body>
<main id="app" aria-live="polite"></main>
<script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
