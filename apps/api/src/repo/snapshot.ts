import type { Tx } from '@saras/db';
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

// What an arena's repo holds after each approval (git.ts commits it):
//   README.md                         the arena's name and goal, links to the two logs and to
//                                     every approved document
//   progress.md                       the factual project log (progress/progress-log.ts): where
//                                     the cycle is, a dated Timeline, then one section per entry
//   state.md                          the AI's date-wise summary of the discussions, decisions in
//                                     bold (progress/state-log.ts)
//   cycle-<n>/<stage>/<file>          each approved artifact, under the gate that approved it
//   docs/<file>                       approved artifacts with no gate (none yet in Phase A)
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
    'This repository is kept by Saras. Each commit is an approved stage gate or an update of the logs.',
    '',
    '- [progress.md](progress.md): the project log, with stage moves, approvals, pushes, versions and their authors, and commits, by date',
    '- [state.md](state.md): what the team discussed and decided, day by day',
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
    author: { name: 'Saras AI', email: 'noreply@saras.app' },
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

  // The approval that approved each artifact gives its folder (cycle and stage of the gate).
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
    const folder =
      row.cycle_number !== null && row.stage
        ? `cycle-${row.cycle_number}/${row.stage.toLowerCase()}`
        : 'docs';
    let path = `${folder}/${fileName(row.name)}`;
    for (let n = 2; used.has(path); n += 1) path = `${folder}/${n}-${fileName(row.name)}`;
    used.add(path);
    files.push({ path, content: row.content ?? '' });
  }

  files.push({ path: 'README.md', content: renderReadme(project, files) });
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
