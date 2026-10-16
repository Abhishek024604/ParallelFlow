import { sql } from 'kysely';
import type { Database, Tx } from './database.js';

// Local demo data in the ADR-029 shape: each arena is a hidden org + team + project + arena + one
// agent session. Fixed ids make the seed idempotent (ON CONFLICT DO NOTHING).

const USERS = {
  asha: { id: '0192f0a0-0000-7000-8000-00000000a001', email: 'asha@example.com', name: 'Asha Rao' },
  ben: { id: '0192f0a0-0000-7000-8000-00000000a002', email: 'ben@example.com', name: 'Ben Ortiz' },
  chitra: {
    id: '0192f0a0-0000-7000-8000-00000000a003',
    email: 'chitra@example.com',
    name: 'Chitra Iyer',
  },
} as const;

type SeedUser = (typeof USERS)[keyof typeof USERS];

interface ArenaSeed {
  n: number;
  name: string;
  key: string;
  owner: SeedUser;
  members: SeedUser[];
}

const ARENAS: ArenaSeed[] = [
  { n: 1, name: 'Checkout revamp', key: 'CHK', owner: USERS.asha, members: [USERS.chitra] },
  { n: 2, name: 'Mobile onboarding', key: 'MOB', owner: USERS.ben, members: [] },
];

// Same list as create arena (apps/api/src/arenas/create-arena.ts).
const MEMBER_CAPABILITIES = [
  'arena.read',
  'arena.post',
  'arena.tag_roles',
  'agent.invoke',
  'artifact.push',
  'artifact.edit',
  'artifact.export',
  'task.create',
  'task.assign',
  'task.delegate',
  'stage.request_gate',
];

function id(arena: number, entity: number): string {
  return `0192f0a0-0000-7000-8000-0000000${arena}${String(entity).padStart(4, '0')}`;
}

export async function seed(db: Database): Promise<void> {
  for (const arena of ARENAS) {
    await db.withSystemJob({ orgId: id(arena.n, 1) }, (tx) => seedArena(tx, arena));
  }
}

async function seedArena(tx: Tx, a: ArenaSeed): Promise<void> {
  const org = id(a.n, 1);
  const team = id(a.n, 2);
  const project = id(a.n, 3);
  const ownerRole = id(a.n, 4);
  const memberRole = id(a.n, 5);
  const agent = id(a.n, 6);
  const arena = id(a.n, 7);
  const session = id(a.n, 8);
  const people = [a.owner, ...a.members];

  for (const u of people) {
    await sql`INSERT INTO users (id, email, display_name, handle)
              VALUES (${u.id}, ${u.email}, ${u.name}, ${u.email.split('@')[0]})
              ON CONFLICT DO NOTHING`.execute(tx);
  }
  await sql`INSERT INTO organizations (id, slug, name, onboarded_by)
            VALUES (${org}, ${a.key.toLowerCase()}, ${a.name}, ${a.owner.id}) ON CONFLICT DO NOTHING`.execute(
    tx,
  );
  await sql`INSERT INTO org_policies (org_id) VALUES (${org}) ON CONFLICT DO NOTHING`.execute(tx);
  await sql`INSERT INTO teams (id, org_id, name, created_by)
            VALUES (${team}, ${org}, ${a.name}, ${a.owner.id}) ON CONFLICT DO NOTHING`.execute(tx);
  await sql`INSERT INTO projects (id, org_id, team_id, key, name, status, setup_completed_at, created_by)
            VALUES (${project}, ${org}, ${team}, ${a.key}, ${a.name}, 'active', now(), ${a.owner.id})
            ON CONFLICT DO NOTHING`.execute(tx);
  await sql`INSERT INTO project_roles (id, org_id, project_id, key, name, system_kind) VALUES
              (${ownerRole}, ${org}, ${project}, 'owner', 'Owner', 'owner'),
              (${memberRole}, ${org}, ${project}, 'member', 'Member', NULL)
            ON CONFLICT DO NOTHING`.execute(tx);
  for (const capability of MEMBER_CAPABILITIES) {
    await sql`INSERT INTO role_capabilities (org_id, role_id, capability)
              VALUES (${org}, ${memberRole}, ${capability}) ON CONFLICT DO NOTHING`.execute(tx);
  }

  for (const u of people) {
    const isOwner = u === a.owner;
    await sql`INSERT INTO org_memberships (org_id, user_id, role)
              VALUES (${org}, ${u.id}, ${isOwner ? 'owner' : 'member'}) ON CONFLICT DO NOTHING`.execute(
      tx,
    );
    await sql`INSERT INTO team_members (org_id, team_id, user_id, role)
              VALUES (${org}, ${team}, ${u.id}, ${isOwner ? 'owner' : 'member'}) ON CONFLICT DO NOTHING`.execute(
      tx,
    );
    await sql`INSERT INTO project_members (org_id, project_id, user_id, added_by)
              VALUES (${org}, ${project}, ${u.id}, ${a.owner.id}) ON CONFLICT DO NOTHING`.execute(
      tx,
    );
    await sql`INSERT INTO project_member_roles (org_id, project_id, user_id, role_id)
              VALUES (${org}, ${project}, ${u.id}, ${isOwner ? ownerRole : memberRole})
              ON CONFLICT DO NOTHING`.execute(tx);
  }

  await sql`INSERT INTO agents (id, org_id, kind, name)
            VALUES (${agent}, ${org}, 'central', 'AI') ON CONFLICT DO NOTHING`.execute(tx);
  await sql`INSERT INTO arenas (id, org_id, project_id)
            VALUES (${arena}, ${org}, ${project}) ON CONFLICT DO NOTHING`.execute(tx);
  await sql`INSERT INTO agent_sessions (id, org_id, session_key, kind, arena_id, scope_project_id, agent_id, status)
            VALUES (${session}, ${org}, ${`org/${org}/project/${project}/arena`}, 'arena', ${arena},
                    ${project}, ${agent}, 'ready')
            ON CONFLICT DO NOTHING`.execute(tx);
}
