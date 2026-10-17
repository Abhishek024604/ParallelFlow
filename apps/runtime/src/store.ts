import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateSessionRequest } from '@saras/runtime-client';

// Session metadata on disk (ADR-035). Each session has its own folder, named by a hash of its
// session_key: <data>/sessions/<session_id>/{session.json, pi/, workspace/, agent/}. The folder holds
// that session's Pi session file and nothing of any other session. Tool tokens are never written.

export interface SessionMeta {
  session_id: string;
  session_key: string;
  kind: 'arena' | 'private';
  scope: CreateSessionRequest['scope'];
  profile: string;
  agent: CreateSessionRequest['agent'];
  context_seed: NonNullable<CreateSessionRequest['context_seed']>;
  bound_project_id: string | null;
  created_at: string;
  archived_at: string | null;
  last_compacted_at: string | null;
  /** App notices (mode system, reply_expected false) not yet shown to the model. */
  pending_notes: string[];
}

export interface SessionPaths {
  root: string;
  piDir: string;
  cwd: string;
  agentDir: string;
}

/** Deterministic: the same session_key always maps to the same id (and folder). */
export function sessionIdFor(sessionKey: string): string {
  return `ses_${createHash('sha256').update(sessionKey).digest('hex').slice(0, 32)}`;
}

export interface SessionStore {
  load(sessionId: string): SessionMeta | null;
  save(meta: SessionMeta): void;
  paths(sessionId: string): SessionPaths;
}

const SESSION_ID = /^ses_[0-9a-f]{32}$/;

export class FsSessionStore implements SessionStore {
  constructor(private readonly dataDir: string) {}

  paths(sessionId: string): SessionPaths {
    if (!SESSION_ID.test(sessionId)) throw new Error('Bad session id');
    const root = join(this.dataDir, 'sessions', sessionId);
    return {
      root,
      piDir: join(root, 'pi'),
      cwd: join(root, 'workspace'),
      agentDir: join(root, 'agent'),
    };
  }

  load(sessionId: string): SessionMeta | null {
    if (!SESSION_ID.test(sessionId)) return null;
    try {
      return JSON.parse(readFileSync(join(this.paths(sessionId).root, 'session.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  save(meta: SessionMeta): void {
    const { root } = this.paths(meta.session_id);
    mkdirSync(root, { recursive: true });
    const file = join(root, 'session.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(meta));
    renameSync(`${file}.tmp`, file);
  }
}

/** For tests. */
export class MemorySessionStore implements SessionStore {
  readonly saved = new Map<string, SessionMeta>();

  load(sessionId: string): SessionMeta | null {
    const meta = this.saved.get(sessionId);
    return meta ? structuredClone(meta) : null;
  }

  save(meta: SessionMeta): void {
    this.saved.set(meta.session_id, structuredClone(meta));
  }

  paths(sessionId: string): SessionPaths {
    const root = `/mem/${sessionId}`;
    return { root, piDir: `${root}/pi`, cwd: `${root}/workspace`, agentDir: `${root}/agent` };
  }
}
