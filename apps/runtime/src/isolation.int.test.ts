import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@parallelflow/observability';
import {
  type CreateSessionRequest,
  eventText,
  mintToolToken,
  type RuntimeEvent,
} from '@parallelflow/runtime-client';
import { afterAll, describe, expect, it } from 'vitest';
import { modelConfig } from './config.js';
import { PiEngine } from './pi-engine.js';
import { RuntimeService } from './service.js';
import { FsSessionStore } from './store.js';
import { FakeTools } from './testing.js';

// Isolation canary (doc 08 rule 1, must stay at 100%): two arena sessions each learn a unique canary.
// Asking session A about B's canary never returns it, and B's canary is never in A's files. Calls the
// real model: runs only with OPENROUTER_API_KEY set and Node >= 22.19 (Pi). Never run in CI by default.

const key = process.env.OPENROUTER_API_KEY;
const dataDir = mkdtempSync(join(tmpdir(), 'parallelflow-runtime-canary-'));
const engine = new PiEngine({
  apiKey: key,
  routing: modelConfig(process.env),
  dataDir,
});
await engine.init();
const eventsText = (events: RuntimeEvent[]): string =>
  events
    .filter((e) => e.type === 'message.completed')
    .map(eventText)
    .join(' ');

/** Every file under a session folder, as one string. */
function folderText(dir: string): string {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => readFileSync(join(f.parentPath, f.name), 'utf8'))
    .join(' ');
}

const enabled = Boolean(key) && engine.unavailableReason() === null;

function session(): CreateSessionRequest {
  const org = randomUUID();
  const project = randomUUID();
  const agent = randomUUID();
  const sessionKey = `org/${org}/project/${project}/arena`;
  return {
    session_key: sessionKey,
    kind: 'arena',
    scope: { org_id: org, project_id: project },
    profile: 'central_arena',
    agent: { id: agent, kind: 'central', display_name: 'AI' },
    tool_token: mintToolToken(
      {
        sessionKey,
        orgId: org,
        projectId: project,
        principal: { type: 'agent', id: agent, kind: 'central' },
        scopes: [],
      },
      'c'.repeat(40),
      'http://127.0.0.1:9/mcp',
    ),
  };
}

describe.skipIf(!enabled)('session isolation canary (real model)', () => {
  const service = new RuntimeService({
    engine,
    tools: new FakeTools(),
    store: new FsSessionStore(dataDir),
    logger: createLogger({ name: 'canary', level: 'silent' }),
  });

  afterAll(() => {
    service.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function ask(sessionId: string, text: string): Promise<string> {
    const turnId = randomUUID();
    service.createTurn(sessionId, {
      turn_id: turnId,
      input: { author: { type: 'user', id: randomUUID(), display_name: 'Tester' }, text },
    });
    const log = service.events(sessionId, turnId);
    await new Promise<void>((resolve) => {
      if (log.finished) return resolve();
      log.subscribe(() => log.finished && resolve());
    });
    return eventsText(log.since());
  }

  it('never leaks one session’s canary into another', { timeout: 180_000 }, async () => {
    const canaryA = `CANARY-A-${randomUUID()}`;
    const canaryB = `CANARY-B-${randomUUID()}`;
    const a = service.createSession(session()).session.session_id;
    const b = service.createSession(session()).session.session_id;

    await ask(a, `Remember this code word for later: ${canaryA}. Reply "ok".`);
    await ask(b, `Remember this code word for later: ${canaryB}. Reply "ok".`);

    const fromA = await ask(a, 'List every code word anyone has told you, exactly as written.');
    expect(fromA).toContain(canaryA);
    expect(fromA).not.toContain(canaryB);
    const fromB = await ask(b, 'List every code word anyone has told you, exactly as written.');
    expect(fromB).toContain(canaryB);
    expect(fromB).not.toContain(canaryA);
    const store = new FsSessionStore(dataDir);
    expect(folderText(store.paths(a).root)).not.toContain(canaryB);
    expect(folderText(store.paths(b).root)).not.toContain(canaryA);
  });
});
