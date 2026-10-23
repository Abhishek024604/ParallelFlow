// Where the agent's chats are kept: Pi session files (JSONL) in the extension's global storage, one
// folder per workspace folder, so a reload or a crashed agent picks the chat up again. They hold the
// conversation, so they stay on this computer and are never logged.
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export interface ChatSession {
  path: string;
  title: string;
  modified: number;
}

/** The session folder for `root` under the extension's global storage. */
export function sessionDirFor(globalStorage: string, root: string): string {
  const key = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
  return path.join(globalStorage, 'sessions', key.slice(0, 16));
}

/** The chats in `dir`, newest first. Empty sessions (no message yet) are left out. */
export async function listSessions(dir: string, limit = 30): Promise<ChatSession[]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const files = await Promise.all(
    names
      .filter((n) => n.endsWith('.jsonl'))
      .map(async (n) => {
        const file = path.join(dir, n);
        const stat = await fsp.stat(file).catch(() => undefined);
        return stat ? { file, modified: stat.mtimeMs } : undefined;
      }),
  );
  const out: ChatSession[] = [];
  for (const f of files
    .filter((x): x is { file: string; modified: number } => Boolean(x))
    .sort((a, b) => b.modified - a.modified)
    .slice(0, limit)) {
    const title = sessionTitle(await fsp.readFile(f.file, 'utf8').catch(() => ''));
    if (title) out.push({ path: f.file, title, modified: f.modified });
  }
  return out;
}

/** The chat's name, or its first message; '' when it has no message yet. */
export function sessionTitle(jsonl: string): string {
  let name = '';
  let first = '';
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let entry: { type?: string; name?: unknown; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type === 'session_info' && typeof entry.name === 'string') name = entry.name;
    if (!first && entry.type === 'message' && entry.message?.role === 'user') {
      first = textOf(entry.message.content);
    }
  }
  const title = (name || first).replace(/\s+/g, ' ').trim();
  return title.length > 80 ? `${title.slice(0, 79)}…` : title;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      (c as { type?: unknown }).type === 'text' ? String((c as { text?: unknown }).text ?? '') : '',
    )
    .join(' ');
}
