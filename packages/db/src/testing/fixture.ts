import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import type { Database } from '../database.js';

// One org with at least one row in each of the 41 RLS tables, and four users who see it differently:
//   owner    – project Owner (all capabilities), owns a private session, in a DM with member
//   member   – custom "dev" role with arena.read + arena.post
//   observer – Observer role with arena.read only (cannot post)
//   outsider – org member who is NOT a project member (like an org admin; ADR "oversight ≠ access")

export interface TenantFixture {
  orgId: string;
  users: { owner: string; member: string; observer: string; outsider: string };
  projectId: string;
  arenaId: string;
  privateSessionId: string;
  dmThreadId: string;
}

export async function createTenantFixture(db: Database, label: string): Promise<TenantFixture> {
  const orgId = randomUUID();
  const u = {
    owner: randomUUID(),
    member: randomUUID(),
    observer: randomUUID(),
    outsider: randomUUID(),
  };
  const { unit, team, project, ownerRole, observerRole, devRole } = ids(
    'unit',
    'team',
    'project',
    'ownerRole',
    'observerRole',
    'devRole',
  );
  const { centralAgent, personalAgent, arena, arenaSession, privateSession, privateAgentSession } =
    ids(
      'centralAgent',
      'personalAgent',
      'arena',
      'arenaSession',
      'privateSession',
      'privateAgentSession',
    );
  const { dm, cycle, transition, approval, task, projectArtifact, privateArtifact, version } = ids(
    'dm',
    'cycle',
    'transition',
    'approval',
    'task',
    'projectArtifact',
    'privateArtifact',
    'version',
  );
  const { turn, routine, invite, request } = ids('turn', 'routine', 'invite', 'request');
  const sha = `sha-${orgId}`;
  const now = new Date();
  const later = new Date(now.getTime() + 7 * 86_400_000);
  const tag = `${label}-${orgId.slice(0, 8)}`;

  await db.withSystemJob({ orgId }, async (tx) => {
    const run = (q: RawBuilder<unknown>) => q.execute(tx);

    for (const [name, id] of Object.entries(u)) {
      await run(sql`INSERT INTO users (id, email, display_name, handle)
                    VALUES (${id}, ${`${name}@${tag}.test`}, ${name}, ${`${name}-${tag}`})`);
    }
    await run(
      sql`INSERT INTO organizations (id, slug, name, onboarded_by) VALUES (${orgId}, ${tag}, ${tag}, ${u.owner})`,
    );
    await run(sql`INSERT INTO org_policies (org_id) VALUES (${orgId})`);
    await run(
      sql`INSERT INTO org_units (id, org_id, name, depth, path) VALUES (${unit}, ${orgId}, 'Unit', 1, ${`/${unit}/`})`,
    );
    for (const id of Object.values(u)) {
      await run(
        sql`INSERT INTO org_memberships (org_id, user_id, role) VALUES (${orgId}, ${id}, 'member')`,
      );
    }
    await run(
      sql`INSERT INTO unit_role_assignments (org_id, unit_id, user_id, role) VALUES (${orgId}, ${unit}, ${u.outsider}, 'unit_lead')`,
    );
    await run(
      sql`INSERT INTO teams (id, org_id, unit_id, name, created_by) VALUES (${team}, ${orgId}, ${unit}, 'Team', ${u.owner})`,
    );
    await run(
      sql`INSERT INTO team_members (org_id, team_id, user_id, role) VALUES (${orgId}, ${team}, ${u.owner}, 'owner')`,
    );
    await run(
      sql`INSERT INTO agents (id, org_id, kind, name) VALUES (${centralAgent}, ${orgId}, 'central', 'AI')`,
    );
    await run(
      sql`INSERT INTO agents (id, org_id, kind, owner_user_id, name) VALUES (${personalAgent}, ${orgId}, 'personal', ${u.owner}, 'Mine')`,
    );

    await run(sql`INSERT INTO projects (id, org_id, team_id, key, name, status, setup_completed_at, created_by)
                  VALUES (${project}, ${orgId}, ${team}, 'PRJ', 'Project', 'active', now(), ${u.owner})`);
    await run(sql`INSERT INTO project_roles (id, org_id, project_id, key, name, system_kind) VALUES
                    (${ownerRole}, ${orgId}, ${project}, 'owner', 'Owner', 'owner'),
                    (${observerRole}, ${orgId}, ${project}, 'observer', 'Observer', 'observer'),
                    (${devRole}, ${orgId}, ${project}, 'dev', 'Developer', NULL)`);
    await run(sql`INSERT INTO role_capabilities (org_id, role_id, capability) VALUES
                    (${orgId}, ${devRole}, 'arena.read'), (${orgId}, ${devRole}, 'arena.post'),
                    (${orgId}, ${observerRole}, 'arena.read')`);
    for (const [user, role] of [
      [u.owner, ownerRole],
      [u.member, devRole],
      [u.observer, observerRole],
    ] as const) {
      await run(
        sql`INSERT INTO project_members (org_id, project_id, user_id) VALUES (${orgId}, ${project}, ${user})`,
      );
      await run(sql`INSERT INTO project_member_roles (org_id, project_id, user_id, role_id)
                    VALUES (${orgId}, ${project}, ${user}, ${role})`);
    }
    await run(sql`INSERT INTO stage_gate_policies (org_id, project_id, stage, approver_role_ids)
                  VALUES (${orgId}, ${project}, 'PLAN', ${[ownerRole]})`);
    await run(
      sql`INSERT INTO agent_policies (org_id, project_id, class, autonomy) VALUES (${orgId}, ${project}, 'answer', 'act')`,
    );
    await run(sql`INSERT INTO access_requests (id, org_id, project_id, requester_id, reason)
                  VALUES (${request}, ${orgId}, ${project}, ${u.outsider}, 'Please')`);
    await run(sql`INSERT INTO invitations (id, org_id, email, scope, expires_at, token_hash, invited_by)
                  VALUES (${invite}, ${orgId}, ${`new@${tag}.test`}, 'org', ${later}, ${`tok-${invite}`}, ${u.owner})`);

    await run(
      sql`INSERT INTO arenas (id, org_id, project_id) VALUES (${arena}, ${orgId}, ${project})`,
    );
    await run(sql`INSERT INTO agent_sessions (id, org_id, session_key, kind, arena_id, scope_project_id, agent_id)
                  VALUES (${arenaSession}, ${orgId}, ${`org/${orgId}/project/${project}/arena`}, 'arena', ${arena}, ${project}, ${centralAgent})`);
    await run(
      sql`INSERT INTO private_sessions (id, org_id, owner_user_id, title) VALUES (${privateSession}, ${orgId}, ${u.owner}, 'Draft')`,
    );
    await run(sql`INSERT INTO agent_sessions (id, org_id, session_key, kind, private_session_id, agent_id)
                  VALUES (${privateAgentSession}, ${orgId}, ${`org/${orgId}/user/${u.owner}/private/${privateSession}`}, 'private', ${privateSession}, ${personalAgent})`);
    await run(sql`INSERT INTO bridge_events (org_id, user_id, private_session_id, project_id, direction, ref)
                  VALUES (${orgId}, ${u.owner}, ${privateSession}, ${project}, 'pull_context', '{}')`);

    await run(
      sql`INSERT INTO dm_threads (id, org_id, participant_key) VALUES (${dm}, ${orgId}, ${`${u.member}:${u.owner}`})`,
    );
    await run(
      sql`INSERT INTO dm_participants (org_id, thread_id, user_id) VALUES (${orgId}, ${dm}, ${u.owner}), (${orgId}, ${dm}, ${u.member})`,
    );

    const arenaMsg = randomUUID();
    await run(sql`INSERT INTO messages (id, created_at, org_id, arena_id, author_type, author_id, body)
                  VALUES (${arenaMsg}, ${now}, ${orgId}, ${arena}, 'user', ${u.owner}, 'arena hello')`);
    await run(sql`INSERT INTO messages (org_id, private_session_id, author_type, author_id, body)
                  VALUES (${orgId}, ${privateSession}, 'user', ${u.owner}, 'private note')`);
    await run(sql`INSERT INTO messages (org_id, dm_thread_id, author_type, author_id, body)
                  VALUES (${orgId}, ${dm}, 'user', ${u.member}, 'dm hello')`);
    await run(sql`INSERT INTO message_mentions (org_id, message_id, message_created_at, mentioned_type, mentioned_id)
                  VALUES (${orgId}, ${arenaMsg}, ${now}, 'user', ${u.member})`);

    await run(sql`INSERT INTO sdlc_cycles (id, org_id, project_id, number, title, created_by)
                  VALUES (${cycle}, ${orgId}, ${project}, 1, 'Cycle 1', ${u.owner})`);
    await run(sql`INSERT INTO stage_transitions (id, org_id, cycle_id, to_stage, kind, actor_type, actor_id)
                  VALUES (${transition}, ${orgId}, ${cycle}, 'PLAN', 'open', 'user', ${u.owner})`);
    await run(sql`INSERT INTO approval_requests (id, org_id, project_id, cycle_id, stage, title, detail, approver_role_ids, expires_at)
                  VALUES (${approval}, ${orgId}, ${project}, ${cycle}, 'PLAN', 'Leave PLAN', '{}', ${[ownerRole]}, ${later})`);
    await run(
      sql`INSERT INTO approval_votes (org_id, approval_id, user_id, decision) VALUES (${orgId}, ${approval}, ${u.owner}, 'approve')`,
    );
    await run(sql`INSERT INTO tasks (id, org_id, project_id, cycle_id, title, created_by)
                  VALUES (${task}, ${orgId}, ${project}, ${cycle}, 'Task', ${u.owner})`);

    await run(
      sql`INSERT INTO blobs (org_id, sha256, size_bytes, s3_key) VALUES (${orgId}, ${sha}, 1, ${`k/${sha}`})`,
    );
    await run(sql`INSERT INTO artifacts (id, org_id, lineage_id, scope, kind, name, project_id, created_by_type, created_by)
                  VALUES (${projectArtifact}, ${orgId}, ${randomUUID()}, 'project', 'spec', 'Spec', ${project}, 'user', ${u.owner})`);
    await run(sql`INSERT INTO artifacts (id, org_id, lineage_id, scope, kind, name, owner_user_id, private_session_id, created_by_type, created_by)
                  VALUES (${privateArtifact}, ${orgId}, ${randomUUID()}, 'private', 'document', 'Notes', ${u.owner}, ${privateSession}, 'user', ${u.owner})`);
    await run(sql`INSERT INTO artifact_versions (id, org_id, artifact_id, version_no, blob_sha256, created_by_type, created_by)
                  VALUES (${version}, ${orgId}, ${projectArtifact}, 1, ${sha}, 'user', ${u.owner})`);
    await run(sql`INSERT INTO evidence (org_id, artifact_version_id, stage_transition_id, kind, ref)
                  VALUES (${orgId}, ${version}, ${transition}, 'link', 'https://example.com')`);

    await run(
      sql`INSERT INTO runtime_turns (id, org_id, agent_session_id, requested_by) VALUES (${turn}, ${orgId}, ${arenaSession}, ${u.owner})`,
    );
    await run(sql`INSERT INTO app_tool_calls (org_id, turn_id, session_key, tool, args_hash, outcome)
                  VALUES (${orgId}, ${turn}, ${`org/${orgId}/project/${project}/arena`}, 'tasks.list', 'h', 'ok')`);
    await run(sql`INSERT INTO routines (id, org_id, project_id, kind, name, schedule_cron, created_by)
                  VALUES (${routine}, ${orgId}, ${project}, 'daily_digest', 'Digest', '0 9 * * *', ${u.owner})`);
    await run(
      sql`INSERT INTO routine_runs (org_id, routine_id, scheduled_for, status) VALUES (${orgId}, ${routine}, ${now}, 'queued')`,
    );

    await run(sql`INSERT INTO notifications (org_id, user_id, type, project_id, title, resource_type, resource_id, deep_link, dedupe_key)
                  VALUES (${orgId}, ${u.owner}, 'system', ${project}, 'Hi', 'project', ${project}, '/', ${`n-${orgId}`})`);
    await run(
      sql`INSERT INTO notification_prefs (user_id, org_id, type, channel) VALUES (${u.owner}, ${orgId}, 'system', 'in_app')`,
    );
    await run(sql`INSERT INTO outbox_events (org_id, topic, type, aggregate_id, payload)
                  VALUES (${orgId}, 'project', 'project.created', ${project}, '{}')`);
    await run(sql`INSERT INTO audit_events (org_id, actor_type, actor_id, action, target_type, target_id, outcome, hash)
                  VALUES (${orgId}, 'user', ${u.owner}, 'project.create', 'project', ${project}, 'ok', ${Buffer.from([0])})`);
  });

  return {
    orgId,
    users: u,
    projectId: project,
    arenaId: arena,
    privateSessionId: privateSession,
    dmThreadId: dm,
  };
}

function ids<K extends string>(...names: K[]): Record<K, string> {
  return Object.fromEntries(names.map((name) => [name, randomUUID()])) as Record<K, string>;
}
