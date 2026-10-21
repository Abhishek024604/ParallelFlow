import { classifyPath, LAYOUT, normalizeArchPath } from './layout.js';
import {
  lockedBlockViolation,
  readFrontmatter,
  replaceSection,
  setFrontmatterFields,
  writeFrontmatter,
} from './markdown.js';
import { canStart, phaseForWrite, type Snapshot } from './state.js';
import type { ArchStore } from './store.js';
import { hashInputs } from './validate.js';

// Every agent write to arch/ goes through here (swa_write). The rules are code, not prompt text:
//   - inputs/ is the architect's: a missing input may be copied in once, never changed;
//   - .swa/ (approvals) is never written by the agent;
//   - only the layout's paths (layout.ts), so every file has a phase and a gate;
//   - a phase's files are written only when the gates before it are approved (or overridden);
//   - locked blocks stay exactly as they are;
//   - the agent never marks anything approved: a frontmatter `status: approved` becomes `draft`.

export interface WriteRequest {
  path: string;
  /** The whole new text, or with `section` the new body of that section. */
  content: string;
  section?: string;
}

export type WritePlan =
  | { ok: true; path: string; text: string; created: boolean; notes: string[] }
  | { ok: false; error: string };

export async function planWrite(
  store: ArchStore,
  snap: Snapshot,
  req: WriteRequest,
): Promise<WritePlan> {
  const path = normalizeArchPath(req.path);
  if (!path) return { ok: false, error: `"${req.path}" is not a path inside arch/.` };
  const kind = classifyPath(path);
  const before = await store.read(path);

  if (kind.kind === 'state') {
    return {
      ok: false,
      error: 'arch/.swa/ holds the approvals: only the architect changes it, with /swa approve.',
    };
  }
  if (kind.kind === 'unknown') {
    return {
      ok: false,
      error: `arch/${path} is not part of the SWA layout. Use one of:\n${LAYOUT}`,
    };
  }
  if (kind.kind === 'input') {
    if (before !== null) {
      return {
        ok: false,
        error: `arch/${path} is an input: inputs are the architect's and are never edited. Ask the architect to change it.`,
      };
    }
    if (req.section)
      return { ok: false, error: 'A new input is copied whole: leave out `section`.' };
    return {
      ok: true,
      path,
      text: req.content,
      created: true,
      notes: ['Copied in as an input; from now on only the architect changes it.'],
    };
  }

  const owner = phaseForWrite(path);
  if (owner) {
    const start = canStart(snap, owner.phase, owner.component);
    if (!start.ok) return { ok: false, error: start.reason };
  }

  let text = req.content;
  if (req.section) {
    if (before === null)
      return { ok: false, error: `arch/${path} does not exist yet: write it whole first.` };
    const replaced = replaceSection(before, req.section, req.content);
    if ('error' in replaced) return { ok: false, error: `arch/${path}: ${replaced.error}.` };
    text = replaced.text;
  }

  const notes: string[] = [];
  if (before !== null) {
    const locked = lockedBlockViolation(before, text);
    if (locked)
      return { ok: false, error: `Not saved: ${locked}. Keep those blocks exactly as they are.` };
  }
  if (path.endsWith('.md')) {
    const fm = readFrontmatter(text);
    if (fm.error) return { ok: false, error: `arch/${path}: ${fm.error}.` };
    if (fm.data['status'] === 'approved') {
      text = setFrontmatterFields(text, { status: 'draft' });
      notes.push('Saved as a draft: only the architect approves (/swa approve).');
    }
    // The hashes of the inputs it was built from, for impact analysis (the model cannot hash).
    const hashed = await hashInputs(store, readFrontmatter(text).data);
    if (hashed) text = writeFrontmatter(hashed, readFrontmatter(text).body);
  }
  const approved = snap.files.find((f) => f.path === path && f.state === 'approved');
  if (approved?.gate) {
    notes.push(
      `This changes an approved file, so ${approved.gate}${approved.component ? `:${approved.component}` : ''} is open again until the architect approves it.`,
    );
  }
  return { ok: true, path, text, created: before === null, notes };
}
