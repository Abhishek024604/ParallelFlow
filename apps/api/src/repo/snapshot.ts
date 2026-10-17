import type { Tx } from '@saras/db';
import { sql } from 'kysely';
import type { CommitInput, SnapshotFile } from './git.js';

// What an arena's repo holds after each approval (git.ts commits it):
//   README.md                         the arena's name and goal
//   progress.md                       current cycle and stage, and every stage move (who, when)
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

interface MoveRow {
  number: number;
  from_stage: string | null;
  to_stage: string;
  kind: string;
  reason: string | null;
  actor: string | null;
  created_at: Date;
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

const MOVE: Record<string, string> = {
  advance: 'approved',
  send_back: 'sent back',
  open: 'opened',
  auto: 'moved',
  skip: 'skipped',
};

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
  const { projectId } = input;
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

  const { rows: moves } = await sql<MoveRow>`
    SELECT c.number, t.from_stage::text AS from_stage, t.to_stage::text AS to_stage, t.kind,
           t.reason, u.display_name AS actor, t.created_at
      FROM stage_transitions t
      JOIN sdlc_cycles c ON c.id = t.cycle_id
      LEFT JOIN users u ON u.id = t.actor_id
     WHERE c.project_id = ${projectId}
     ORDER BY t.created_at`.execute(tx);
  const current = await tx
    .selectFrom('sdlc_cycles')
    .select(['number', 'stage', 'status'])
    .where('project_id', '=', projectId)
    .orderBy('number', 'desc')
    .executeTakeFirst();

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

  files.push({
    path: 'README.md',
    content: `# ${project.name}\n\n${project.description ?? ''}\n\nThis repository is kept by Saras. Each commit is an approved stage gate; approved documents live under \`cycle-<n>/<stage>/\`, and \`progress.md\` lists every stage move.\n`,
  });
  const history = moves.map((m) => {
    const what = MOVE[m.kind] ?? m.kind;
    const step = m.from_stage ? `${m.from_stage} → ${m.to_stage}` : m.to_stage;
    const reason = m.reason ? ` (${m.reason.replace(/\s+/g, ' ').slice(0, 200)})` : '';
    return `- ${m.created_at.toISOString().slice(0, 16).replace('T', ' ')} · Cycle ${m.number} · ${step} · ${what} by ${m.actor ?? 'someone'}${reason}`;
  });
  files.push({
    path: 'progress.md',
    content: `# Progress\n\n${
      current ? `Cycle ${current.number} · ${current.stage} (${current.status})` : 'No cycle yet.'
    }\n\n## Stage moves\n\n${history.join('\n') || 'None yet.'}\n\n## Approved documents\n\n${
      files
        .filter((f) => f.path !== 'README.md')
        .map((f) => `- [${f.path}](${encodeURI(f.path)})`)
        .join('\n') || 'None yet.'
    }\n`,
  });

  const summary = input.summary?.trim();
  return {
    files,
    author: input.approver,
    message: `Approve ${input.fromStage} gate · cycle ${input.cycleNumber} → ${input.toStage}${
      summary ? `\n\n${summary.slice(0, 2000)}` : ''
    }`,
  };
}
