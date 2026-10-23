import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listSessions, sessionDirFor, sessionTitle } from './sessions.js';
import { Transcript } from './transcript.js';

const line = (v: unknown) => `${JSON.stringify(v)}\n`;

describe('saved chats', () => {
  it('lists a folder’s chats newest first, titled by their first message', async () => {
    const dir = sessionDirFor(await fsp.mkdtemp(path.join(os.tmpdir(), 'pf-')), '/w');
    expect(sessionDirFor('/g', '/w')).not.toBe(sessionDirFor('/g', '/other'));
    await fsp.mkdir(dir, { recursive: true });
    const header = line({ type: 'session', id: 's', timestamp: 't', cwd: '/w' });
    const user = (text: string) =>
      line({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
    await fsp.writeFile(path.join(dir, 'a.jsonl'), header + user('Add a todo API'));
    await fsp.writeFile(path.join(dir, 'b.jsonl'), header);
    await fsp.writeFile(path.join(dir, 'c.jsonl'), header + user('Fix the tests'));
    await fsp.utimes(path.join(dir, 'a.jsonl'), 1, 1);

    const sessions = await listSessions(dir);
    expect(sessions.map((s) => s.title)).toEqual(['Fix the tests', 'Add a todo API']);
    expect(sessionTitle(header + line({ type: 'session_info', name: 'Todo API' }))).toBe(
      'Todo API',
    );
  });

  it('rebuilds the transcript from a resumed chat', () => {
    const t = new Transcript();
    t.load([
      { role: 'user', content: 'Make server.ts' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'text', text: 'Writing it.' },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'write',
            arguments: { path: 'server.ts', content: 'x' },
          },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'write', content: [], isError: false },
    ]);
    expect(t.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(t.items[2]).toMatchObject({
      tool: 'write',
      summary: 'server.ts',
      status: 'ok',
      diff: '+x',
    });
  });
});
