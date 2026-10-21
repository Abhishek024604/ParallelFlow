// Architect mode's sidebar card: the SWA gates of this folder's arch/ (packages/pi-swa core,
// computed here from the files, never from the model's word), refreshed when arch/ changes.
// Approving is the person's click, confirmed in a modal, then `/swa approve <gate>`, which Pi runs
// as the SWA extension's command (no model in the loop).
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FsArchStore, nextStep, snapshot } from '@saras/pi-swa/core';
import type { ArchitectView } from '../shared/messages.js';

const DIAGRAM = /\.(drawio|excalidraw)$/;

export async function architectView(root: string): Promise<ArchitectView> {
  const store = new FsArchStore(root);
  const snap = await snapshot(store);
  return {
    inputs: { present: snap.inputs.present, missing: [...snap.inputs.missing] },
    gates: snap.gates.map((g) => ({
      key: g.key,
      state: g.state,
      files: g.files.map((f) => ({ path: f.path, state: f.state })),
      missing: g.missing,
      approvable: g.state === 'open' && g.missing.length === 0,
    })),
    next: nextStep(snap),
    diagrams: (await store.list()).filter((p) => DIAGRAM.test(p)),
  };
}

/** Watches arch/ and recomputes the view (debounced). */
export class ArchitectWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  view: ArchitectView | undefined;

  constructor(private readonly onChange: () => void) {}

  /** Starts (or stops, with no root) watching. */
  async watch(root: string | undefined): Promise<void> {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.view = undefined;
    if (!root) return this.onChange();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, 'arch/**'),
    );
    const later = () => this.schedule(root);
    this.watcher.onDidCreate(later);
    this.watcher.onDidChange(later);
    this.watcher.onDidDelete(later);
    await this.refresh(root);
  }

  private schedule(root: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(root), 300);
  }

  async refresh(root: string): Promise<void> {
    try {
      this.view = await architectView(root);
    } catch {
      this.view = undefined;
    }
    this.onChange();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.dispose();
  }
}

/** The file to open for a diagram link from the webview, only inside <root>/arch. */
export function archFile(root: string, rel: string): vscode.Uri | undefined {
  const base = path.resolve(root, 'arch');
  const full = path.resolve(base, rel);
  if (!full.startsWith(base + path.sep)) return undefined;
  return vscode.Uri.file(full);
}
