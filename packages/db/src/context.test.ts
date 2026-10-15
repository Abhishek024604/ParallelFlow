import { describe, expect, it } from 'vitest';
import {
  NIL_UUID,
  SYSTEM_USER_ID,
  identitySettings,
  systemJobSettings,
  tenantSettings,
  userScopeSettings,
} from './context.js';

const ORG = '0192f0a0-0000-7000-8000-000000000001';
const USER = '0192f0a0-0000-7000-8000-000000000002';

describe('tenant context', () => {
  it('sets org, user, search_path; clears email; turns system_job off', () => {
    expect(tenantSettings({ orgId: ORG, userId: USER })).toEqual({
      search_path: 'saras, public',
      'app.org_id': ORG,
      'app.user_id': USER,
      'app.user_email': '',
      'app.system_job': 'off',
    });
  });

  it('system jobs get the nil user and system_job on', () => {
    expect(systemJobSettings({ orgId: ORG })).toEqual({
      search_path: 'saras, public',
      'app.org_id': ORG,
      'app.user_id': SYSTEM_USER_ID,
      'app.user_email': '',
      'app.system_job': 'on',
    });
  });

  it.each([
    ['empty org', { orgId: '', userId: USER }],
    ['empty user', { orgId: ORG, userId: '' }],
    ['non-uuid org', { orgId: 'acme', userId: USER }],
    ['sql in user', { orgId: ORG, userId: "x'; set app.system_job = 'on" }],
    ['nil user', { orgId: ORG, userId: SYSTEM_USER_ID }],
    ['nil org (would turn into user scope)', { orgId: NIL_UUID, userId: USER }],
  ])('rejects %s', (_label, ctx) => {
    expect(() => tenantSettings(ctx)).toThrow(/context/);
  });

  it.each([[''], [NIL_UUID]])('rejects a system job with org %j', (orgId) => {
    expect(() => systemJobSettings({ orgId })).toThrow(/context/);
  });
});

describe('user scope', () => {
  it('uses the nil org, so only own-row policies apply', () => {
    expect(userScopeSettings({ userId: USER })).toEqual({
      search_path: 'saras, public',
      'app.org_id': NIL_UUID,
      'app.user_id': USER,
      'app.user_email': '',
      'app.system_job': 'off',
    });
  });

  it.each([[''], [NIL_UUID], ['not-a-uuid']])('rejects user %j', (userId) => {
    expect(() => userScopeSettings({ userId })).toThrow(/context/);
  });
});

describe('identity scope', () => {
  it('normalises the verified email and acts as nobody', () => {
    expect(identitySettings({ email: '  Asha@Example.COM ' })).toEqual({
      search_path: 'saras, public',
      'app.org_id': NIL_UUID,
      'app.user_id': NIL_UUID,
      'app.user_email': 'asha@example.com',
      'app.system_job': 'off',
    });
  });

  it.each([[''], ['no-at-sign'], ['a@b'], [`${'x'.repeat(320)}@example.com`]])(
    'rejects email %j',
    (email) => {
      expect(() => identitySettings({ email })).toThrow(/context/);
    },
  );
});
