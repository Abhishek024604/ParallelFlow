// The chat webviews: the sidebar view and an optional editor tab load the same bundle with the same
// strict CSP (nonce scripts, no inline handlers, no remote content) and message protocol. ChatHub
// posts state to whichever are open and routes their messages to the controller.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { FromWebview, ToWebview, ViewState } from '../shared/messages.js';

export type Reply = (m: ToWebview) => void;

interface Attached {
  webview: vscode.Webview;
  visible(): boolean;
  /** The script has said `ready`, so messages to it are not lost. */
  ready: boolean;
  /** Chips that arrived before it was ready. */
  pending: string[];
}

export class ChatHub implements vscode.Disposable {
  static readonly viewId = 'parallelflow.sidebar';
  private readonly views = new Set<Attached>();
  private sidebar: Attached | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private last: ViewState | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (m: FromWebview, reply: Reply) => void,
  ) {}

  /** True when any chat is on screen (approvals then show there instead of a modal). */
  get visible(): boolean {
    return [...this.views].some((v) => v.visible());
  }

  private get dist(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'dist');
  }

  /** Loads the chat into a webview and wires its messages. */
  private attach(webview: vscode.Webview, visible: () => boolean): Attached {
    webview.options = { enableScripts: true, localResourceRoots: [this.dist] };
    webview.html = this.html(webview);
    const a: Attached = { webview, visible, ready: false, pending: [] };
    this.views.add(a);
    const reply: Reply = (m) => void webview.postMessage(m);
    webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === 'ready') {
        a.ready = true;
        if (this.last) reply({ type: 'state', state: this.last });
        for (const chip of a.pending.splice(0)) reply({ type: 'addContext', chip });
      }
      this.onMessage(m, reply);
    });
    return a;
  }

  readonly sidebarProvider: vscode.WebviewViewProvider = {
    resolveWebviewView: (view) => {
      const a = this.attach(view.webview, () => view.visible);
      this.sidebar = a;
      view.onDidDispose(() => {
        this.views.delete(a);
        if (this.sidebar === a) this.sidebar = undefined;
      });
    },
  };

  /** "Open chat in editor tab": one panel, revealed if it is already open. */
  openPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'parallelflow.chat',
      'ParallelFlow',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.dist] },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'parallelflow.svg');
    const a = this.attach(panel.webview, () => panel.visible);
    this.panel = panel;
    panel.onDidDispose(() => {
      this.views.delete(a);
      this.panel = undefined;
    });
  }

  post(state: ViewState): void {
    this.last = state;
    const message: ToWebview = { type: 'state', state };
    for (const v of this.views) void v.webview.postMessage(message);
  }

  /** The chat to talk to: the editor tab when it is showing, else the sidebar (revealed). */
  private async target(): Promise<Attached | undefined> {
    if (this.panel?.visible) {
      this.panel.reveal(undefined, false);
      return [...this.views].find((v) => v.webview === this.panel?.webview);
    }
    await vscode.commands.executeCommand(`${ChatHub.viewId}.focus`);
    return this.sidebar;
  }

  /** Shows the chat and puts the cursor in its composer. */
  async focus(): Promise<void> {
    const t = await this.target();
    if (t) void t.webview.postMessage({ type: 'focusComposer' } satisfies ToWebview);
  }

  /** Adds a context chip to the visible chat's composer. */
  async addContext(chip: string): Promise<void> {
    let t = await this.target();
    // Focusing the view resolves it a moment later the first time.
    for (let i = 0; !t && i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      t = this.sidebar;
    }
    if (!t) return;
    if (t.ready) void t.webview.postMessage({ type: 'addContext', chip } satisfies ToWebview);
    else t.pending.push(chip);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const uri = (...p: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.dist, ...p)).toString();
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
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('webview.css')}">
<title>ParallelFlow</title>
</head>
<body>
<main id="app"></main>
<script nonce="${nonce}" src="${uri('webview.js')}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
