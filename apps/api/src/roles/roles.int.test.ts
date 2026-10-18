import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { CreateArenaResponse, Role, RoleList } from '@saras/contracts';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from '@saras/db/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { SessionVerifier } from '../pipeline/auth.js';

// Roles smoke test (build step 8): a Member without role.manage gets 403 → the Owner creates a role
// with role.manage and gives it to her → she can now create roles, but only with capabilities she
// holds; deleting a gate's only approver role → 422 GATE_UNSTAFFED; the last Owner stepping down →
// 409 LAST_OWNER. Real Nest app and database (RLS on); sessions faked as in loop.int.test.ts.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('roles: custom roles, templates and assignments', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let projectId: string;
  let memberRole: string;
  const owner = { id: randomUUID(), name: 'Abhishek Owner' };
  const riya = { id: randomUUID(), name: 'Riya Member' };

  const as = (user: { id: string }) => `Bearer ${user.id}`;
  const send = (
    method: 'post' | 'patch' | 'delete',
    user: { id: string },
    path: string,
    body?: unknown,
  ) => {
    const agent = request(app.getHttpServer());
    const req = agent[method](`/v1/projects/${projectId}${path}`)
      .set('Authorization', as(user))
      .set('Idempotency-Key', randomUUID());
    return body === undefined ? req : req.send(body as object);
  };
  const roles = async (user: { id: string }) => {
    const res = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/roles`)
      .set('Authorization', as(user));
    expect(res.status).toBe(200);
    return res.body as RoleList;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const u of [owner, riya]) {
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

    const { rows } = await query<{ org_id: string; member_role: string }>(
      t.ownerUrl,
      `SELECT org_id, id AS member_role FROM saras.project_roles WHERE project_id = $1 AND key = 'member'`,
      [projectId],
    );
    const { org_id: org } = rows[0]!;
    memberRole = rows[0]!.member_role;
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

  it('lists Owner and Member with counts; a Member sees them read-only', async () => {
    const list = await roles(riya);
    expect(list.viewer.can_manage).toBe(false);
    expect(list.items.map((r) => [r.name, r.member_count])).toEqual([
      ['Owner', 1],
      ['Member', 1],
    ]);
    expect(list.items[0]!.capabilities).toHaveLength(28);
  });

  it('a Member without role.manage gets 403', async () => {
    const res = await send('post', riya, '/roles', { name: 'QA', capabilities: ['arena.read'] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', required_permission: 'cap role.manage' });
  });

  it('create a role and assign it → that teammate can now do the capability', async () => {
    const created = await send('post', owner, '/roles', {
      name: 'Role admin',
      capabilities: ['arena.read', 'role.manage'],
    });
    expect(created.status).toBe(201);
    const admin = created.body as Role;
    expect(admin).toMatchObject({ key: 'role_admin', member_count: 0 });

    const assigned = await send('patch', owner, `/members/${riya.id}`, {
      role_ids: [memberRole, admin.id],
    });
    expect(assigned.status).toBe(200);
    expect(assigned.body.roles.map((r: { name: string }) => r.name)).toEqual([
      'Member',
      'Role admin',
    ]);

    const mine = await send('post', riya, '/roles', {
      name: 'Tester',
      capabilities: ['arena.post'],
    });
    expect(mine.status).toBe(201);
    // …but never a capability she does not hold herself.
    const escalate = await send('post', riya, '/roles', {
      name: 'Release',
      capabilities: ['stage.approve.DEPLOY'],
    });
    expect(escalate.status).toBe(403);
  });

  it("deleting a gate's only approver role → 422 GATE_UNSTAFFED", async () => {
    const applied = await send('post', owner, '/roles:apply-template', {
      template_key: 'lean_squad',
      gates: true,
    });
    expect(applied.status).toBe(200);
    const builder = (applied.body as RoleList).items.find((r) => r.key === 'builder')!;
    expect(builder.approves).toEqual(['BUILD', 'TEST']);

    const res = await send('delete', owner, `/roles/${builder.id}`);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'GATE_UNSTAFFED' });
  });

  it('removing the last Owner → 409 LAST_OWNER', async () => {
    const res = await send('patch', owner, `/members/${owner.id}`, { role_ids: [memberRole] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'LAST_OWNER' });
  });
});
