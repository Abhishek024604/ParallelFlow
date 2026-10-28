import {
  ARCH_SEPARATOR,
  ARCH_STATE_NAME,
  archPathOf,
  stageOfFileName,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import { publicCopy, renderProgress } from '../progress/progress-log.js';
import {
  PROGRESS_FILE_NAME,
  progressContext,
  readProgressLog,
  readStateLog,
} from '../progress/progress-store.js';
import { renderState, STATE_FILE_NAME } from '../progress/state-log.js';
import type { CommitInput, SnapshotFile } from './git.js';

// What an arena's repo holds after each approval (git.ts commits it). Always the latest approved
// version of each document at a stable path; the history is the git log (ADR-040):
//   README.md                         the arena's name and goal, links to the logs and documents
//   AGENTS.md                         how AI coding agents (and people) work in this repo; a
//                                     human-kept AGENTS.local.md is never touched
//   PROGRESS.md                       the factual project log (progress/progress-log.ts)
//   STATE.md                          the AI's date-wise summary of the discussions (state-log.ts)
//   docs/plan/<file>                  plan*, requirements*
//   docs/product/<path>               the PM's documents ("pm › backlog › STORY-001.md")
//   docs/design/<file>                hld*, lld*, architecture* ...
//   docs/design/architecture/<path>   ... or SWA's files at their arch/ path (decisions/ADR-...,
//                                     hld/hld.md, lld/CMP-001/openapi.yaml, model.yaml, stack.md)
//   docs/build|test|deploy|maintain/  the rest, by the stage of their standard name
// Only approved versions go in: drafts stay in the app until a gate approves them.
// Read in the vote's own tenant transaction, before it commits.

interface ApprovedRow {
  name: string;
  content: Buffer | null;
  cycle_number: number | null;
  stage: string | null;
}

/** A safe file name: letters, digits, space . _ - only; `.md` when it has no extension. */
export function fileName(name: string): string {
  const clean =
    name
      .normalize('NFKD')
      .replace(/[^\w .-]+/g, '-')
      .replace(/^[.\s-]+|[\s.-]+$/g, '')
      .slice(0, 100) || 'untitled';
  return /\.[A-Za-z0-9]{1,8}$/.test(clean) ? clean : `${clean}.md`;
}

const PM_PREFIX = `pm${ARCH_SEPARATOR}`;
const SAFE_SEGMENT = /^\w[\w .-]{0,99}$/;

/** A folder name: like fileName, without an extension added. */
function folderName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w .-]+/g, '-')
      .replace(/^[.\s-]+|[\s.-]+$/g, '')
      .slice(0, 100) || 'untitled'
  );
}

/** `path` when every segment is a plain name (no "..", no empty part), else null. */
function safeRelPath(path: string): string | null {
  const parts = path.split('/');
  return parts.length <= 8 && parts.every((p) => SAFE_SEGMENT.test(p)) ? parts.join('/') : null;
}

/**
 * Where an approved document lives in the repo (the layout above), or null when it is not
 * published (SWA's own state). `gateStage` files a name that is not standard under its gate.
 */
export function docPath(name: string, gateStage: string | null): string | null {
  if (name === ARCH_STATE_NAME) return null;
  if (name.startsWith(PM_PREFIX)) {
    const parts = name
      .slice(PM_PREFIX.length)
      .split(ARCH_SEPARATOR)
      .map((p) => p.trim())
      .filter(Boolean);
    const last = parts.pop();
    if (!last) return null;
    return ['docs/product', ...parts.slice(0, 6).map(folderName), fileName(last)].join('/');
  }
  const stage = stageOfFileName(name);
  if (stage === 'DESIGN' || !stage) {
    const arch = archPathOf(name);
    const rel = arch ? safeRelPath(arch) : null;
    if (rel) return `docs/design/architecture/${rel}`;
  }
  const folder = (stage ?? gateStage ?? 'PLAN').toLowerCase();
  return `docs/${folder}/${fileName(name)}`;
}

/** AGENTS.md: what this repo is and how coding agents work in it (ParallelFlow keeps it). */
export function renderAgents(
  project: { name: string; description: string | null },
  approved: readonly SnapshotFile[],
): string {
  const docs = approved.map((f) => `- ${f.path}`).join('\n');
  return [
    '# AGENTS.md',
    '',
    'Instructions for AI coding agents, and the people working with them, in this repository.',
    'ParallelFlow keeps this file up to date: do not edit it. Put your own notes in AGENTS.local.md,',
    'which ParallelFlow never changes, and read it too when it is there.',
    '',
    '## What this repository is',
    '',
    `The code and the approved documents of **${project.name}**, built with ParallelFlow.`,
    ...(project.description ? ['', project.description] : []),
    '',
    '## Read first',
    '',
    '1. `docs/design/architecture/` and `docs/design/`: the architecture, HLD and LLDs. Follow them.',
    '2. `docs/plan/`: the plan and the requirements. `docs/product/`: the product documents, backlog and stories.',
    '3. `docs/design/architecture/decisions/`: the architecture decisions (ADRs).',
    '4. `PROGRESS.md` (where the project is) and `STATE.md` (what the team discussed and decided).',
    '',
    '## How to work',
    '',
    '- One branch per story, named `feat/<story>-<slug>`, for example `feat/STORY-012-checkout-retry`.',
    '- Small commits, each with a clear message.',
    '- When the work is ready, open a pull request into the default branch. Say what changed and how you tested it.',
    '- Never push to the default branch (main) and never merge a pull request: people review and merge.',
    '- Do not edit README.md, PROGRESS.md, STATE.md, AGENTS.md or the documents under `docs/`: ParallelFlow',
    '  writes them from approved documents. Suggest changes in the arena instead.',
    '',
    '## Approved documents',
    '',
    docs || 'None yet.',
    '',
  ].join('\n');
}

/** README.md: the arena's name and goal, links to the two logs and every approved document. */
export function renderReadme(
  project: { name: string; description: string | null },
  approved: readonly SnapshotFile[],
): string {
  const docs = approved.map((f) => `- [${f.path}](${encodeURI(f.path)})`).join('\n');
  return [
    `# ${project.name}`,
    '',
    ...(project.description ? [project.description, ''] : []),
    'This repository is kept by ParallelFlow. Each commit is an approved stage gate or an update of the logs.',
    '',
    '- [PROGRESS.md](PROGRESS.md): the project log, with stage moves, approvals, pushes, versions and their authors, and commits, by date',
    '- [STATE.md](STATE.md): what the team discussed and decided, day by day',
    '- [AGENTS.md](AGENTS.md): how AI coding agents work in this repository',
    '',
    '## Approved documents',
    '',
    docs || 'None yet.',
    '',
  ].join('\n');
}

export async function buildSnapshot(
  tx: Tx,
  input: {
    projectId: string;
    approver: { name: string; email: string };
    cycleNumber: number;
    fromStage: string;
    toStage: string;
    summary: string | null;
  },
): Promise<CommitInput> {
  const files = await snapshotFiles(tx, input.projectId);
  const summary = input.summary?.trim();
  return {
    files,
    author: input.approver,
    message: `Approve ${input.fromStage} gate · cycle ${input.cycleNumber} → ${input.toStage}${
      summary ? `\n\n${summary.slice(0, 2000)}` : ''
    }`,
  };
}

/** The follow-up commit when the logs are updated after the gate's commit. */
export async function buildProgressSnapshot(tx: Tx, projectId: string): Promise<CommitInput> {
  return {
    files: await snapshotFiles(tx, projectId),
    author: { name: 'ParallelFlow AI', email: 'noreply@parallelflow.app' },
    message: 'Update progress and state',
  };
}

/** Every file of the arena's repo as of now (read in the caller's transaction). */
async function snapshotFiles(tx: Tx, projectId: string): Promise<SnapshotFile[]> {
  const project = await tx
    .selectFrom('projects')
    .select(['name', 'description'])
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();

  // The gate that approved each artifact files a name that is not standard under its stage.
  const { rows: approved } = await sql<ApprovedRow>`
    SELECT a.name, b.content, gate.number AS cycle_number, gate.stage
      FROM artifacts a
      JOIN artifact_versions v ON v.artifact_id = a.id AND v.version_no = a.approved_version_no
      JOIN blobs b ON b.org_id = v.org_id AND b.sha256 = v.blob_sha256
      LEFT JOIN LATERAL (
        SELECT c.number, ar.stage::text AS stage
          FROM approval_requests ar JOIN sdlc_cycles c ON c.id = ar.cycle_id
         WHERE ar.project_id = a.project_id AND ar.status = 'approved'
           AND ar.detail ->> 'artifact_id' = a.id::text
         ORDER BY ar.decided_at DESC NULLS LAST
         LIMIT 1) gate ON true
     WHERE a.project_id = ${projectId} AND a.scope = 'project'
       AND a.approved_version_no IS NOT NULL
     ORDER BY a.name`.execute(tx);

  const files: SnapshotFile[] = [];
  const used = new Set<string>();
  for (const row of approved) {
    const path = docPath(row.name, row.stage);
    if (!path) continue;
    const slash = path.lastIndexOf('/');
    let unique = path;
    for (let n = 2; used.has(unique); n += 1) {
      unique = `${path.slice(0, slash + 1)}${n}-${path.slice(slash + 1)}`;
    }
    used.add(unique);
    files.push({ path: unique, content: row.content ?? '' });
  }

  const docs = [...files];
  files.push({ path: 'README.md', content: renderReadme(project, docs) });
  files.push({ path: 'AGENTS.md', content: renderAgents(project, docs) });
  const progress = await readProgressLog(tx, projectId);
  files.push({
    path: PROGRESS_FILE_NAME,
    content: publicCopy(
      progress?.content ?? renderProgress(await progressContext(tx, projectId), []),
    ),
  });
  const state = await readStateLog(tx, projectId);
  files.push({ path: STATE_FILE_NAME, content: publicCopy(state?.content ?? renderState([])) });
  return files;
}
