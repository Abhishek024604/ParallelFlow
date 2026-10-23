import { archDocName, archPathOf } from '@parallelflow/contracts';
import { type Approval, type ArchStore, contentHash } from '@parallelflow/pi-swa';

// SWA in the app (docs/15, packages/pi-swa): arch/<path> lives as documents in an arena, or in one
// private chat, named with the folders as " › " ("arch › hld › hld.md", @parallelflow/contracts
// arch-docs.ts: names cannot hold "/"), so they show in the chat's files like any document. They
// are read and written through this session's own App Tools (so the
// token's scope and the arena's autonomy policy apply, and a write is an ordinary AI draft). A
// person approves a version in the app (the document's Approve button: the arena owner, or the
// chat's owner); that approval is what SWA's gates read.
//
// A draft becomes visible to artifacts.list only after the API has stored the turn's
// artifact.proposed event, so writes are kept in a session overlay until the list shows a newer
// version than the one the write was based on (read-your-writes inside the session).

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

interface Entry {
  id: string;
  path: string;
  latest: number;
  approved: number | null;
}

const LIST_TTL_MS = 3_000;

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The App Tools a store uses: the arena's documents, or this private chat's. */
export interface DocumentTools {
  list: { name: string; args: Record<string, unknown> };
  read: string;
  save: string;
  /** Who approves (said in SWA's status and refusals). */
  approver: string;
}

export const ARENA_DOCUMENTS: DocumentTools = {
  list: { name: 'artifacts_list', args: {} },
  read: 'artifacts_read',
  save: 'artifacts_create_draft',
  approver: 'the arena owner',
};

export const PRIVATE_DOCUMENTS: DocumentTools = {
  list: { name: 'private_list_artifacts', args: { this_chat: true, limit: 100 } },
  read: 'private_read_artifact',
  save: 'private_save_artifact',
  approver: 'you',
};

export class AppArchStore implements ArchStore {
  readonly kind = 'app' as const;
  readonly approver: string;
  private listed: { at: number; entries: Entry[] } | null = null;
  private readonly overlay = new Map<string, { text: string; base: number }>();
  private readonly versions = new Map<string, string>();

  constructor(
    private readonly call: CallTool,
    private readonly tools: DocumentTools = ARENA_DOCUMENTS,
    private readonly now: () => number = Date.now,
  ) {
    this.approver = tools.approver;
  }

  private async entries(): Promise<Entry[]> {
    if (this.listed && this.now() - this.listed.at < LIST_TTL_MS) return this.listed.entries;
    const data = parse<{
      artifacts?: {
        artifact_id: string;
        name: string;
        latest_version_no: number;
        approved_version_no: number | null;
      }[];
    }>(await this.call(this.tools.list.name, this.tools.list.args));
    const entries = (data?.artifacts ?? []).flatMap((a) => {
      const path = typeof a.name === 'string' ? archPathOf(a.name) : null;
      return path
        ? [
            {
              id: a.artifact_id,
              path,
              latest: a.latest_version_no,
              approved: a.approved_version_no,
            },
          ]
        : [];
    });
    this.listed = { at: this.now(), entries };
    // A write is visible once the arena has a newer version than the one it was based on.
    for (const [path, w] of this.overlay) {
      const e = entries.find((x) => x.path === path);
      if (e && e.latest > w.base) this.overlay.delete(path);
    }
    return entries;
  }

  private async version(entry: Entry, versionNo: number): Promise<string | null> {
    const key = `${entry.id}:${versionNo}`;
    const cached = this.versions.get(key);
    if (cached !== undefined) return cached;
    const data = parse<{ artifact?: { content?: string } }>(
      await this.call(this.tools.read, { artifact_id: entry.id, version_no: versionNo }),
    );
    const text = data?.artifact?.content;
    if (typeof text !== 'string') return null;
    this.versions.set(key, text);
    return text;
  }

  async list(): Promise<string[]> {
    const paths = new Set((await this.entries()).map((e) => e.path));
    for (const p of this.overlay.keys()) paths.add(p);
    return [...paths].sort();
  }

  async read(path: string): Promise<string | null> {
    const entries = await this.entries();
    const mine = this.overlay.get(path);
    if (mine) return mine.text;
    const entry = entries.find((e) => e.path === path);
    return entry ? this.version(entry, entry.latest) : null;
  }

  async write(path: string, text: string): Promise<void> {
    const entry = (await this.entries()).find((e) => e.path === path);
    await this.call(this.tools.save, {
      name: archDocName(path),
      kind: /\.(drawio|excalidraw)$/.test(path) ? 'diagram' : 'document',
      content: text,
    });
    this.overlay.set(path, { text, base: entry?.latest ?? 0 });
    this.listed = null;
  }

  async approvals(): Promise<Record<string, Approval>> {
    const out: Record<string, Approval> = {};
    for (const e of await this.entries()) {
      if (e.approved === null) continue;
      const text = await this.version(e, e.approved);
      if (text === null) continue;
      out[e.path] = { hash: contentHash(text), gate: '', by: this.approver, at: '' };
    }
    return out;
  }

  async overrides() {
    return [];
  }
}
