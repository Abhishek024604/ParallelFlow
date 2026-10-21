import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { type GateId, type PhaseId, STATE_FILE } from './layout.js';

// Where arch/ lives. Two hosts, one interface:
//   - files (VS Code coding agent, plain pi): <repo>/arch on disk, approvals in arch/.swa/state.json
//     written only by the architect's /swa approve command;
//   - arena (apps/runtime): arena documents named arch/<path>, approved by a person in the app.
// Paths are relative to arch/ and already normalized (layout.ts normalizeArchPath).

export interface Approval {
  /** contentHash() of the approved text. A later edit no longer matches: the file is a draft again. */
  hash: string;
  gate: string;
  by: string;
  at: string;
}

export interface Override {
  phase: PhaseId;
  component?: string;
  by: string;
  at: string;
}

export interface Baseline {
  gate: GateId;
  at: string;
  /** The Git tag, when one was made. */
  tag?: string;
}

export interface ArchStore {
  readonly kind: 'files' | 'arena';
  /** Every path under arch/ (state file excluded), sorted. */
  list(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** Approved content per path. */
  approvals(): Promise<Record<string, Approval>>;
  overrides(): Promise<Override[]>;
  /** The architect's actions. Absent when the host approves elsewhere (the arena's app). */
  approve?(
    entries: readonly { path: string; hash: string }[],
    gate: string,
    by: string,
  ): Promise<void>;
  addOverride?(override: Override): Promise<void>;
  addBaseline?(baseline: Baseline): Promise<void>;
}

interface StateFile {
  version: 1;
  approvals: Record<string, Approval>;
  overrides: Override[];
  baselines: Baseline[];
}

const EMPTY_STATE = (): StateFile => ({ version: 1, approvals: {}, overrides: [], baselines: [] });

const MAX_FILES = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

/** arch/ on disk under `projectRoot`. */
export class FsArchStore implements ArchStore {
  readonly kind = 'files' as const;
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = resolve(projectRoot, 'arch');
  }

  /** The absolute path, or an error when it would leave arch/ (also through a symlink). */
  private abs(path: string): string {
    const full = resolve(this.root, path);
    if (!full.startsWith(this.root + sep)) throw new Error(`"${path}" is outside arch/`);
    if (existsSync(this.root)) {
      const realRoot = realpathSync(this.root);
      let probe = full;
      while (!existsSync(probe) && probe !== this.root) probe = dirname(probe);
      const real = realpathSync(probe);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        throw new Error(`"${path}" leads outside arch/`);
      }
    }
    return full;
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (out.length >= MAX_FILES) return;
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) {
          const rel = relative(this.root, full).split(sep).join('/');
          if (rel !== STATE_FILE) out.push(rel);
        }
      }
    };
    walk(this.root);
    return out.sort();
  }

  async read(path: string): Promise<string | null> {
    const full = this.abs(path);
    if (!existsSync(full) || !lstatSync(full).isFile()) return null;
    if (lstatSync(full).size > MAX_BYTES) throw new Error(`"${path}" is larger than 2 MB`);
    return readFileSync(full, 'utf8');
  }

  async write(path: string, text: string): Promise<void> {
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES)
      throw new Error('the file is larger than 2 MB');
    const full = this.abs(path);
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.swa-tmp`;
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, full);
  }

  private state(): StateFile {
    const full = join(this.root, STATE_FILE);
    if (!existsSync(full)) return EMPTY_STATE();
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<StateFile>;
      return {
        version: 1,
        approvals: parsed.approvals && typeof parsed.approvals === 'object' ? parsed.approvals : {},
        overrides: Array.isArray(parsed.overrides) ? parsed.overrides : [],
        baselines: Array.isArray(parsed.baselines) ? parsed.baselines : [],
      };
    } catch {
      return EMPTY_STATE();
    }
  }

  private save(state: StateFile): void {
    const full = join(this.root, STATE_FILE);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  async approvals(): Promise<Record<string, Approval>> {
    return this.state().approvals;
  }

  async overrides(): Promise<Override[]> {
    return this.state().overrides;
  }

  async approve(entries: readonly { path: string; hash: string }[], gate: string, by: string) {
    const state = this.state();
    const at = new Date().toISOString();
    for (const e of entries) state.approvals[e.path] = { hash: e.hash, gate, by, at };
    this.save(state);
  }

  async addOverride(override: Override): Promise<void> {
    const state = this.state();
    state.overrides.push(override);
    this.save(state);
  }

  async addBaseline(baseline: Baseline): Promise<void> {
    const state = this.state();
    state.baselines.push(baseline);
    this.save(state);
  }
}

/** In memory (tests, and a base for host adapters). */
export class MemoryArchStore implements ArchStore {
  readonly kind: 'files' | 'arena';
  readonly files = new Map<string, string>();
  readonly approved: Record<string, Approval> = {};
  readonly overridden: Override[] = [];
  readonly baselines: Baseline[] = [];

  constructor(files: Record<string, string> = {}, kind: 'files' | 'arena' = 'files') {
    this.kind = kind;
    for (const [p, t] of Object.entries(files)) this.files.set(p, t);
  }

  async list() {
    return [...this.files.keys()].sort();
  }
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.files.set(path, text);
  }
  async approvals() {
    return this.approved;
  }
  async overrides() {
    return this.overridden;
  }
  async approve(entries: readonly { path: string; hash: string }[], gate: string, by: string) {
    for (const e of entries) this.approved[e.path] = { hash: e.hash, gate, by, at: 'now' };
  }
  async addOverride(override: Override) {
    this.overridden.push(override);
  }
  async addBaseline(baseline: Baseline) {
    this.baselines.push(baseline);
  }
}
