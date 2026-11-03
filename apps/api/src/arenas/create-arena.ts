import {
  type CreateArena,
  type CreateArenaResponse,
  formatInviteToken,
  INVITE_TTL_DAYS,
  uuidv7,
} from '@parallelflow/contracts';
import { type Database, emit, recordArenaEvent } from '@parallelflow/db';
import { inviteSecretFor } from '../invites/links.js';
import { arenaKey, inviteSecretHash, randomSlug } from './naming.js';

// Create arena (ADR-029). One transaction creates the hidden org and everything an arena needs:
//   organizations + org_policies + owner membership, team + owner, project (active, hidden),
//   Owner (system) and Member roles, the creator as project Owner, stage gates PLAN…DEPLOY (approval,
//   Owner, 1 approval), agent autonomy defaults (doc 03 §3.6), the AI agent, the arena, its agent
//   session (provisioning; the runtime arrives in step 4), cycle 1 at PLAN, invitations, and the
//   outbox events (ids only).
//
// The org does not exist yet, so no membership can be verified: this is the one flow that opens an
// unchecked tenant context (withTenant) for a freshly generated org id. That is why this file is in
// TENANT_CREATION_ALLOWLIST (eslint.config.mjs). The id is ours, never the client's.
//
// Invite secrets are derived from the invitation id (invites/links.ts). Only SHA-256(secret) is
// stored; links are never logged.

/** The Member role's capabilities, as approved for the MVP (ADR-029 defaults). */
export const MEMBER_CAPABILITIES = [
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
] as const;

/** Stages with a gate to leave them. MAINTAIN has none: the next cycle is opened with cycle.open. */
export const GATED_STAGES = ['PLAN', 'DESIGN', 'BUILD', 'TEST', 'DEPLOY'] as const;

/** Agent autonomy defaults, doc 03 §3.6. */
export const AGENT_POLICY_DEFAULTS = {
  answer: 'act',
  post: 'act',
  draft_artifacts: 'act',
  tasks: 'suggest',
  request_gate: 'approve',
  assigned_work: 'approve',
  notify: 'act',
} as const;

export interface Creator {
  userId: string;
  email: string;
}

export interface CreateArenaOptions {
  webOrigin: string;
  /** Derives each invite's secret from its id (invites/links.ts), so links can be shown again. */
  inviteKey: Buffer;
  now?: Date;
}

export async function createArena(
  db: Database,
  creator: Creator,
  input: CreateArena,
  options: CreateArenaOptions,
): Promise<CreateArenaResponse> {
  const now = options.now ?? new Date();
  const own = creator.email.trim().toLowerCase();
  const emails = (input.invite_emails ?? []).filter((email) => email !== own);
  const org = uuidv7();
  const ids = {
    team: uuidv7(),
    project: uuidv7(),
    ownerRole: uuidv7(),
    memberRole: uuidv7(),
    agent: uuidv7(),
    arena: uuidv7(),
    session: uuidv7(),
    cycle: uuidv7(),
  };
  const key = arenaKey(input.name);
  const description = input.description ?? null;
  const invites = emails.map((email) => ({
    id: uuidv7(),
    email,
    secret: '',
  }));
  for (const invite of invites) invite.secret = inviteSecretFor(options.inviteKey, invite.id);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const actor = { type: 'user' as const, id: creator.userId, on_behalf_of: null };

  // ADR-029: the tenant is the org this transaction creates (see the note at the top).
  await db.withTenant({ orgId: org, userId: creator.userId }, async (tx) => {
    await tx
      .insertInto('organizations')
      .values({ id: org, slug: randomSlug(), name: input.name, onboarded_by: creator.userId })
      .execute();
    await tx.insertInto('org_policies').values({ org_id: org }).execute();
    await tx
      .insertInto('org_memberships')
      .values({ org_id: org, user_id: creator.userId, role: 'owner' })
      .execute();
    await tx
      .insertInto('teams')
      .values({ id: ids.team, org_id: org, name: input.name, created_by: creator.userId })
      .execute();
    await tx
      .insertInto('team_members')
      .values({ org_id: org, team_id: ids.team, user_id: creator.userId, role: 'owner' })
      .execute();
    await tx
      .insertInto('projects')
      .values({
        id: ids.project,
        org_id: org,
        team_id: ids.team,
        key,
        name: input.name,
        description,
        status: 'active',
        role_template: 'blank',
        discoverability: 'hidden',
        setup_completed_at: now,
        created_by: creator.userId,
      })
      .execute();
    await tx
      .insertInto('project_roles')
      .values([
        {
          id: ids.ownerRole,
          org_id: org,
          project_id: ids.project,
          key: 'owner',
          name: 'Owner',
          system_kind: 'owner',
        },
        {
          id: ids.memberRole,
          org_id: org,
          project_id: ids.project,
          key: 'member',
          name: 'Member',
          system_kind: null,
        },
      ])
      .execute();
    await tx
      .insertInto('role_capabilities')
      .values(
        MEMBER_CAPABILITIES.map((capability) => ({
          org_id: org,
          role_id: ids.memberRole,
          capability,
        })),
      )
      .execute();
    await tx
      .insertInto('project_members')
      .values({
        org_id: org,
        project_id: ids.project,
        user_id: creator.userId,
        added_by: creator.userId,
      })
      .execute();
    await tx
      .insertInto('project_member_roles')
      .values({
        org_id: org,
        project_id: ids.project,
        user_id: creator.userId,
        role_id: ids.ownerRole,
      })
      .execute();
    await tx
      .insertInto('stage_gate_policies')
      .values(
        GATED_STAGES.map((stage) => ({
          org_id: org,
          project_id: ids.project,
          stage,
          mode: 'approval' as const,
          approver_role_ids: [ids.ownerRole],
          min_approvals: 1,
        })),
      )
      .execute();
    await tx
      .insertInto('agent_policies')
      .values(
        Object.entries(AGENT_POLICY_DEFAULTS).map(([cls, autonomy]) => ({
          org_id: org,
          project_id: ids.project,
          class: cls,
          autonomy,
          updated_by: creator.userId,
        })),
      )
      .execute();
    await tx
      .insertInto('agents')
      .values({ id: ids.agent, org_id: org, kind: 'central', name: 'AI' })
      .execute();
    await tx
      .insertInto('arenas')
      .values({ id: ids.arena, org_id: org, project_id: ids.project })
      .execute();
    await tx
      .insertInto('agent_sessions')
      .values({
        id: ids.session,
        org_id: org,
        session_key: `org/${org}/project/${ids.project}/arena`,
        kind: 'arena',
        arena_id: ids.arena,
        scope_project_id: ids.project,
        agent_id: ids.agent,
        runtime_kind: 'stub',
        status: 'provisioning',
      })
      .execute();
    await tx
      .insertInto('sdlc_cycles')
      .values({
        id: ids.cycle,
        org_id: org,
        project_id: ids.project,
        number: 1,
        title: 'Cycle 1',
        stage: 'PLAN',
        status: 'active',
        opened_reason: 'initial',
        created_by: creator.userId,
      })
      .execute();
    if (invites.length) {
      await tx
        .insertInto('invitations')
        .values(
          invites.map((invite) => ({
            id: invite.id,
            org_id: org,
            email: invite.email,
            scope: 'project',
            org_role: 'member' as const,
            project_id: ids.project,
            project_role_ids: [ids.memberRole],
            expires_at: expiresAt,
            token_hash: inviteSecretHash(invite.secret),
            invited_by: creator.userId,
          })),
        )
        .execute();
    }

    // The activity log starts with the arena (ADR-044); invitations are counted, never named.
    const scope = { orgId: org, projectId: ids.project };
    const me = { type: 'user' as const, id: creator.userId };
    await recordArenaEvent(tx, scope, me, {
      action: 'arena.created',
      target: { type: 'arena', id: ids.project },
      metadata: { name: input.name },
    });
    await recordArenaEvent(tx, scope, me, {
      action: 'team.member.joined',
      target: { type: 'user', id: creator.userId },
      metadata: { role: 'Owner' },
    });
    await recordArenaEvent(tx, scope, me, {
      action: 'loop.cycle.started',
      target: { type: 'cycle', id: ids.cycle },
      metadata: { cycle: 1, stage: 'PLAN' },
    });
    if (invites.length) {
      await recordArenaEvent(tx, scope, me, {
        action: 'team.member.invited',
        target: { type: 'arena', id: ids.project },
        metadata: { count: invites.length },
      });
    }
    await emit(tx, {
      type: 'project.setup_completed',
      org_id: org,
      subject: ids.project,
      actor,
      data: { project_id: ids.project, arena_id: ids.arena },
    });
    for (const invite of invites) {
      await emit(tx, {
        type: 'member.invited',
        org_id: org,
        subject: invite.id,
        actor,
        data: { invitation_id: invite.id, project_id: ids.project },
      });
    }
  });

  return {
    id: ids.project,
    arena_id: ids.arena,
    name: input.name,
    description,
    key,
    cycle: 1,
    stage: 'PLAN',
    member_count: 1,
    role: 'owner',
    archived: false,
    invites: invites.map((invite) => ({
      email: invite.email,
      link: `${options.webOrigin}/join/${formatInviteToken(org, invite.secret)}`,
    })),
  };
}
