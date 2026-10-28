import {
  type ArchStore,
  canStart,
  contentHash,
  planWrite,
  renderStatus,
  snapshot,
} from '@parallelflow/pi-swa';
import { archDocName, hasUnsafeNameChars } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import type { AgentTool } from './agent.js';
import { pmFor, swaFor } from './pi-engine.js';
import { AppArchStore, ARENA_DOCUMENTS, PRIVATE_DOCUMENTS } from './swa-store.js';

/** A fake arena behind the App Tools: drafts are stored only when the "API" catches up (flush). */
function fakeArena() {
  const docs = new Map<string, { id: string; versions: string[]; approved: number | null }>();
  const pending: { name: string; content: string }[] = [];
  const calls: string[] = [];
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    calls.push(name);
    if (name === 'artifacts_list') {
      return JSON.stringify({
        artifacts: [...docs].map(([n, d]) => ({
          artifact_id: d.id,
          name: n,
          latest_version_no: d.versions.length,
          approved_version_no: d.approved,
        })),
      });
    }
    if (name === 'artifacts_read') {
      const doc = [...docs.values()].find((d) => d.id === args['artifact_id']);
      const no = Number(args['version_no'] ?? doc?.versions.length);
      return JSON.stringify({ artifact: { content: doc?.versions[no - 1] } });
    }
    if (name === 'artifacts_create_draft') {
      pending.push({ name: String(args['name']), content: String(args['content']) });
      return JSON.stringify({ status: 'accepted' });
    }
    throw new Error(`unexpected ${name}`);
  };
  const put = (name: string, content: string) => {
    const doc = docs.get(name) ?? { id: `id-${docs.size + 1}`, versions: [], approved: null };
    doc.versions.push(content);
    docs.set(name, doc);
  };
  // Like the API's saveDraft: a name it cannot store (a slash) is dropped.
  const flush = () => {
    for (const p of pending.splice(0)) if (!hasUnsafeNameChars(p.name)) put(p.name, p.content);
  };
  const approve = (name: string) => {
    const doc = docs.get(name);
    if (doc) doc.approved = doc.versions.length;
  };
  return { call, put, flush, approve, docs, calls };
}

const md = (id: string) =>
  `---\nid: ${id}\nstatus: draft\nversion: 1\nowner: architect\ninputs: [inputs/srs.md]\n---\n\n# ${id}\n`;

describe('SWA in an arena', () => {
  it('keeps arch/ as arena documents, with read-your-writes before the draft is stored', async () => {
    const arena = fakeArena();
    arena.put(archDocName('inputs/srs.md'), '# SRS');
    arena.put(archDocName('inputs/goal.md'), '# Goals');
    arena.put('Release notes', 'not SWA');
    let now = 0;
    const store = new AppArchStore(arena.call, ARENA_DOCUMENTS, () => now);
    expect(await store.list()).toEqual(['inputs/goal.md', 'inputs/srs.md']);

    await store.write('00-drivers.md', md('DRIVERS'));
    expect(await store.read('00-drivers.md')).toBe(md('DRIVERS'));
    expect(arena.docs.has(archDocName('00-drivers.md'))).toBe(false); // not stored yet
    arena.flush();
    now += 10_000;
    expect(await store.list()).toContain('00-drivers.md');
    // It is a real document in the chat, under a name people can read.
    expect(arena.docs.has('architecture-drivers.md')).toBe(true);
    await store.write('hld/flows/checkout.drawio', '<mxfile/>');
    arena.flush();
    expect(arena.docs.has('hld-flow-checkout.drawio')).toBe(true);
    expect(await store.read('00-drivers.md')).toBe(md('DRIVERS'));
  });

  it("reads gates from the owner's approvals in the app", async () => {
    const arena = fakeArena();
    arena.put(archDocName('inputs/srs.md'), '# SRS');
    arena.put(archDocName('inputs/goal.md'), '# Goals');
    arena.put(archDocName('00-drivers.md'), md('DRIVERS'));
    let now = 0;
    const store = new AppArchStore(arena.call, ARENA_DOCUMENTS, () => now);

    let snap = await snapshot(store);
    expect(canStart(snap, 'stack')).toMatchObject({ ok: true, unapproved: ['G0'] });
    expect((store as ArchStore).approve).toBeUndefined();

    arena.approve(archDocName('00-drivers.md'));
    now += 10_000;
    snap = await snapshot(store);
    expect(snap.gates[0]).toMatchObject({ gate: 'G0', state: 'approved' });
    expect((await store.approvals())['00-drivers.md']?.hash).toBe(contentHash(md('DRIVERS')));
    expect(await planWrite(store, snap, { path: 'stack.md', content: md('STACK') })).toMatchObject({
      ok: true,
    });

    // A newer draft of an approved document reopens its gate.
    arena.put(archDocName('00-drivers.md'), `${md('DRIVERS')}\nEdited.`);
    now += 10_000;
    expect((await snapshot(store)).gates[0]?.state).toBe('open');
  });

  it('is given only to private chats whose owner installed it, never to arenas or forks', () => {
    const tool = (name: string): AgentTool => ({
      name,
      description: name,
      parameters: {},
      execute: async () => '{}',
    });
    const arenaTools = ['artifacts_list', 'artifacts_read', 'artifacts_create_draft'].map(tool);
    const privateTools = [
      'private_list_artifacts',
      'private_read_artifact',
      'private_save_artifact',
    ].map(tool);
    const ai = { Type: { Unsafe: (x: unknown) => x } } as never;
    const arena = { profile: 'central_arena', agentName: 'AI' } as const;
    const chat = { profile: 'personal_private', agentName: 'AI', extensions: ['swa'] } as const;
    const plain = { profile: 'personal_private', agentName: 'AI' } as const;
    expect(swaFor({ session: chat, tools: privateTools }, ai)?.skills.length).toBeGreaterThan(5);
    expect(swaFor({ session: plain, tools: privateTools }, ai)).toBeNull();
    expect(
      swaFor({ session: { ...arena, extensions: ['swa'] }, tools: arenaTools }, ai),
    ).toBeNull();
    expect(swaFor({ session: chat, tools: privateTools, ephemeral: true }, ai)).toBeNull();
    expect(swaFor({ session: chat, tools: arenaTools }, ai)).toBeNull();
    // The Product Manager follows the same rule.
    const pm = { ...plain, extensions: ['pm'] };
    expect(pmFor({ session: pm })?.skills.length).toBeGreaterThan(5);
    expect(pmFor({ session: plain })).toBeNull();
    expect(pmFor({ session: { ...arena, extensions: ['pm'] } })).toBeNull();
    expect(pmFor({ session: pm, ephemeral: true })).toBeNull();
  });

  it("keeps a private chat's arch/ in that chat, approved by its owner", async () => {
    const chat = fakeArena();
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const renamed: Record<string, string> = {
      private_list_artifacts: 'artifacts_list',
      private_read_artifact: 'artifacts_read',
      private_save_artifact: 'artifacts_create_draft',
    };
    const call = (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return chat.call(renamed[name] ?? name, args);
    };
    chat.put(archDocName('inputs/srs.md'), '# SRS');
    chat.put(archDocName('inputs/goal.md'), '# Goals');
    chat.put(archDocName('00-drivers.md'), md('DRIVERS'));
    const store = new AppArchStore(call, PRIVATE_DOCUMENTS, () => 0);
    expect(renderStatus(await snapshot(store))).toContain('press Approve on its documents');
    expect(calls[0]).toEqual({
      name: 'private_list_artifacts',
      args: { this_chat: true, limit: 100 },
    });
    await store.write('stack.md', md('STACK'));
    expect(calls.at(-1)?.name).toBe('private_save_artifact');
  });
});
