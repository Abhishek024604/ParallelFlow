import { type Approval, type ArchStore, contentHash } from '@saras/pi-swa';

// SWA in an arena (docs/15, packages/pi-swa): arch/<path> lives as arena documents named
// "arch/<path>", read and written through this session's own App Tools (so the token's scope and
// the arena's autonomy policy apply, and a write is an ordinary AI draft). A person approves a
// version in the app (the document's Approve button); that approval is what SWA's gates read.
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

const PREFIX = 'arch/';
const LIST_TTL_MS = 3_000;

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export class ArenaArchStore implements ArchStore {
  readonly kind = 'arena' as const;
  private listed: { at: number; entries: Entry[] } | null = null;
  private readonly overlay = new Map<string, { text: string; base: number }>();
  private readonly versions = new Map<string, string>();

  constructor(
    private readonly call: CallTool,
    private readonly now: () => number = Date.now,
  ) {}

  private async entries(): Promise<Entry[]> {
    if (this.listed && this.now() - this.listed.at < LIST_TTL_MS) return this.listed.entries;
    const data = parse<{
      artifacts?: {
        artifact_id: string;
        name: string;
        latest_version_no: number;
        approved_version_no: number | null;
      }[];
    }>(await this.call('artifacts_list', {}));
    const entries = (data?.artifacts ?? [])
      .filter((a) => typeof a.name === 'string' && a.name.startsWith(PREFIX))
      .map((a) => ({
        id: a.artifact_id,
        path: a.name.slice(PREFIX.length),
        latest: a.latest_version_no,
        approved: a.approved_version_no,
      }));
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
      await this.call('artifacts_read', { artifact_id: entry.id, version_no: versionNo }),
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
    await this.call('artifacts_create_draft', {
      name: `${PREFIX}${path}`,
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
      out[e.path] = { hash: contentHash(text), gate: '', by: 'arena', at: '' };
    }
    return out;
  }

  async overrides() {
    return [];
  }
}
