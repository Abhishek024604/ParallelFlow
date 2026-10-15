import { describe, expect, it } from 'vitest';
import { SYSTEM_USER_ID, tenantSettings, systemJobSettings } from './context.js';

const ORG = '0192f0a0-0000-7000-8000-000000000001';
const USER = '0192f0a0-0000-7000-8000-000000000002';

describe('tenant context', () => {
  it('sets org, user, search_path and turns system_job off', () => {
    expect(tenantSettings({ orgId: ORG, userId: USER })).toEqual({
      search_path: 'saras, public',
      'app.org_id': ORG,
      'app.user_id': USER,
      'app.system_job': 'off',
    });
  });

  it('system jobs get the nil user and system_job on', () => {
    expect(systemJobSettings({ orgId: ORG })).toEqual({
      search_path: 'saras, public',
      'app.org_id': ORG,
      'app.user_id': SYSTEM_USER_ID,
      'app.system_job': 'on',
    });
  });

  it.each([
    ['empty org', { orgId: '', userId: USER }],
    ['empty user', { orgId: ORG, userId: '' }],
    ['non-uuid org', { orgId: 'acme', userId: USER }],
    ['sql in user', { orgId: ORG, userId: "x'; set app.system_job = 'on" }],
    ['nil user', { orgId: ORG, userId: SYSTEM_USER_ID }],
  ])('rejects %s', (_label, ctx) => {
    expect(() => tenantSettings(ctx)).toThrow(/tenant context/);
  });

  it('rejects a system job without an org', () => {
    expect(() => systemJobSettings({ orgId: '' })).toThrow(/tenant context/);
  });
});
