import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  ArenaMessagePage,
  CreateArenaResponse,
  LoopActionResult,
  LoopState,
} from '@parallelflow/contracts';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from '@parallelflow/db/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { SessionVerifier } from '../pipeline/auth.js';

// Loop smoke test (build step 7): request the PLAN gate → the card is in the stream → a Member who is
// not an approver gets 403 → the Owner approves → the cycle is in DESIGN and the transition is
// recorded; with forbid_self_approval the requester cannot approve their own gate. Real Nest app and
// database (RLS on); sessions faked with `Authorization: Bearer <user id>` as in messages.int.test.ts.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('loop: gate requests and votes', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let projectId: string;
  const owner = { id: randomUUID(), name: 'Abhishek Owner' };
  const riya = { id: randomUUID(), name: 'Riya Member' };
  const stranger = { id: randomUUID(), name: 'Sam Stranger' };

  const as = (user: { id: string }) => `Bearer ${user.id}`;
  const post = (user: { id: string }, path: string, body: unknown = {}) =>
    request(app.getHttpServer())
      .post(`/v1/projects/${projectId}${path}`)
      .set('Authorization', as(user))
      .set('Idempotency-Key', randomUUID())
      .send(body as object);
  const state = async (user: { id: string }) => {
    const res = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/cycles/current`)
      .set('Authorization', as(user));
    expect(res.status).toBe(200);
    return res.body as LoopState;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const u of [owner, riya, stranger]) {
      await query(
        t.ownerUrl,
        'INSERT INTO saras.users (id, email, display_name, handle) VALUES ($1, $2, $3, $4)',
        [u.id, `${u.id.slice(0, 8)}@adva.test`, u.name, `h${u.id.slice(0, 8)}`],
      );
    }
    app = await createApp({ db: t.db, sessionVerifier: fakeVerifier });
    const created = await request(app.getHttpServer())
      .post('/v1/arenas')
      .set('Authorization', as(owner))
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Interview Prep' });
    expect(created.status).toBe(201);
    projectId = (created.body as CreateArenaResponse).id;

    // Riya as a Member (stage.request_gate, no stage.approve.*). Fixture rows, written as the owner.
    const { rows } = await query<{ org_id: string; member_role: string }>(
      t.ownerUrl,
      `SELECT org_id, id AS member_role FROM saras.project_roles WHERE project_id = $1 AND key = 'member'`,
      [projectId],
    );
    const { org_id: org, member_role: memberRole } = rows[0]!;
    await query(
      t.ownerUrl,
      `INSERT INTO saras.org_memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [org, riya.id],
    );
    await query(
      t.ownerUrl,
      'INSERT INTO saras.project_members (org_id, project_id, user_id) VALUES ($1, $2, $3)',
      [org, projectId, riya.id],
    );
    await query(
      t.ownerUrl,
      'INSERT INTO saras.project_member_roles (org_id, project_id, user_id, role_id) VALUES ($1, $2, $3, $4)',
      [org, projectId, riya.id, memberRole],
    );
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  it('request → approve moves PLAN to DESIGN and records the transition', async () => {
    const before = await state(riya);
    expect(before.cycle).toMatchObject({ number: 1, stage: 'PLAN', status: 'active' });
    expect(before.viewer).toMatchObject({ can_request_gate: true, can_approve: false });
    expect(before.gate).toMatchObject({ approver_roles: ['Owner'], min_approvals: 1 });

    const requested = await post(riya, `/cycles/${before.cycle!.id}/gate-requests`, {});
    expect(requested.status).toBe(201);
    const approvalId = (requested.body as LoopActionResult).approval_id!;
    // One open request per gate.
    expect((await post(riya, `/cycles/${before.cycle!.id}/gate-requests`, {})).status).toBe(409);

    // The gate card is in the stream, with the request's id.
    const page = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/arena/messages`)
      .set('Authorization', as(owner));
    const card = (page.body as ArenaMessagePage).items.find((m) => m.id === approvalId);
    expect(card).toMatchObject({ kind: 'gate', body: 'PLAN gate requested by Riya Member' });

    const pending = await state(owner);
    expect(pending.pending).toMatchObject({
      id: approvalId,
      status: 'pending',
      to_stage: 'DESIGN',
    });
    expect(pending.viewer.can_approve).toBe(true);

    // Not an approver → 403; not a member → 404.
    const denied = await post(riya, `/approvals/${approvalId}/votes`, { decision: 'approve' });
    expect(denied.status).toBe(403);
    expect(
      (await post(stranger, `/approvals/${approvalId}/votes`, { decision: 'approve' })).status,
    ).toBe(404);

    const approved = await post(owner, `/approvals/${approvalId}/votes`, { decision: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ approval_status: 'approved', stage: 'DESIGN' });

    const after = await state(owner);
    expect(after.cycle?.stage).toBe('DESIGN');
    expect(after.pending).toBeNull();
    expect(after.transitions[0]).toMatchObject({
      from_stage: 'PLAN',
      to_stage: 'DESIGN',
      kind: 'advance',
      actor: { id: owner.id },
    });
    const { rows } = await query<{ n: number }>(
      t.ownerUrl,
      `SELECT count(*)::int AS n FROM saras.stage_transitions st
         JOIN saras.sdlc_cycles c ON c.id = st.cycle_id
        WHERE c.project_id = $1 AND st.kind = 'advance' AND $2 = ANY(st.approvals)`,
      [projectId, approvalId],
    );
    expect(rows[0]?.n).toBe(1);
    // A decided request takes no more votes.
    expect(
      (await post(owner, `/approvals/${approvalId}/votes`, { decision: 'approve' })).status,
    ).toBe(409);
  });

  it('blocks self-approval when the gate forbids it; send back needs a reason', async () => {
    await query(
      t.ownerUrl,
      `UPDATE saras.stage_gate_policies SET forbid_self_approval = true
        WHERE project_id = $1 AND stage = 'DESIGN'`,
      [projectId],
    );
    const s = await state(owner);
    const requested = await post(owner, `/cycles/${s.cycle!.id}/gate-requests`, {});
    expect(requested.status).toBe(201);
    const approvalId = (requested.body as LoopActionResult).approval_id!;

    const self = await post(owner, `/approvals/${approvalId}/votes`, { decision: 'approve' });
    expect(self.status).toBe(403);
    expect(self.body).toMatchObject({ code: 'SELF_APPROVAL_FORBIDDEN' });

    expect(
      (await post(owner, `/approvals/${approvalId}/votes`, { decision: 'reject' })).status,
    ).toBe(400);
    const sentBack = await post(owner, `/cycles/${s.cycle!.id}:send-back`, {
      to_stage: 'PLAN',
      reason: 'Storage format is still open',
    });
    expect(sentBack.status).toBe(200);
    expect(sentBack.body).toMatchObject({ stage: 'PLAN', approval_status: 'cancelled' });
    expect((await state(owner)).cycle?.stage).toBe('PLAN');
  });
});
