// Host side of the chat's editor actions: the @ file picker, Insert at cursor, Open diff, opening
// a file (or a `path:L3-L9` chip), and "Add selection to chat". Every path stays inside the folder.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { selectionChip } from '../shared/context-chips.js';
import { rankFiles } from '../shared/file-rank.js';

const FILE_LIMIT = 5000;
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/dist/**,**/.next/**}';

/** The file under the folder for a folder-relative (or agent-reported absolute) path, else undefined. */
export function folderFile(root: string, raw: string): vscode.Uri | undefined {
  const full = path.resolve(root, raw);
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return vscode.Uri.file(full);
}

/** `src/a.ts:L3-L9` → the path and 0-based line range. */
function splitChip(chip: string): { file: string; start?: number; end?: number } {
  const m = /^(.*):L(\d+)(?:-L(\d+))?$/.exec(chip);
  if (!m?.[1]) return { file: chip };
  const start = Number(m[2]) - 1;
  return { file: m[1], start, end: m[3] ? Number(m[3]) - 1 : start };
}

let cache: { root: string; at: number; files: string[] } | undefined;

/** Folder files for the @ picker, ranked by the query (the list is cached for 10 seconds). */
export async function searchFiles(root: string, query: string): Promise<string[]> {
  if (!cache || cache.root !== root || Date.now() - cache.at > 10_000) {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(root, '**/*'),
      EXCLUDE,
      FILE_LIMIT,
    );
    cache = {
      root,
      at: Date.now(),
      files: uris.map((u) => path.relative(root, u.fsPath).replace(/\\/g, '/')),
    };
  }
  return rankFiles(query, cache.files, 30);
}

/** Code block "Insert": into the active editor (or the visible one when the chat tab has focus). */
export async function insertCode(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
  if (!editor) {
    void vscode.window.showInformationMessage('Open a file to insert the code into.');
    return;
  }
  await editor.edit((b) => {
    for (const s of editor.selections) b.replace(s, code);
  });
  await vscode.window.showTextDocument(editor.document, editor.viewColumn);
}

/** VS Code's own diff of the file against git (the Git extension), else the file itself. */
export async function openDiff(root: string, raw: string): Promise<void> {
  const uri = folderFile(root, raw);
  if (!uri) return;
  try {
    await vscode.commands.executeCommand('git.openChange', uri);
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri);
  }
}

export async function openFile(root: string, chip: string): Promise<void> {
  const { file, start, end } = splitChip(chip);
  const uri = folderFile(root, file);
  if (!uri) return;
  const selection =
    start === undefined
      ? undefined
      : new vscode.Range(start, 0, end ?? start, Number.MAX_SAFE_INTEGER);
  await vscode.window.showTextDocument(uri, { preview: true, ...(selection && { selection }) });
}

/** "Add selection to chat": the active editor's selection as a `path:L3-L9` chip. */
export function currentSelectionChip(root: string | undefined): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!root || !editor || editor.document.uri.scheme !== 'file') return undefined;
  if (!folderFile(root, editor.document.uri.fsPath)) return undefined;
  const rel = path.relative(root, editor.document.uri.fsPath);
  const s = editor.selection;
  if (s.isEmpty) return rel.replace(/\\/g, '/');
  // A selection ending at the start of a line does not include that line.
  const endLine = s.end.character === 0 && s.end.line > s.start.line ? s.end.line - 1 : s.end.line;
  return selectionChip(rel, s.start.line + 1, endLine + 1);
}
