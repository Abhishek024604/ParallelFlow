import { MeSchema } from '@saras/contracts';
import { describe, expect, it } from 'vitest';
import { toMe } from './me.js';

const user = {
  id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  email: 'priya@acme.io',
  display_name: 'Priya',
  handle: 'priya',
};
const created = new Date(Date.UTC(2026, 9, 15, 8, 0, 0));
const org = {
  id: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
  slug: 'refunds',
  name: 'Refunds',
  preset: 'startup',
  unit_level_names: ['Business unit'],
  data_region: 'ap-south-1',
  created_at: created,
  role: 'owner',
  status: 'active',
  expires_at: null,
};

describe('toMe', () => {
  it('maps rows to the contract Me shape (openapi_v2 #/components/schemas/Me)', () => {
    const me = toMe(user, [org]);
    expect(MeSchema.parse(me)).toEqual(me);
    expect(me).toEqual({
      ...user,
      orgs: [
        {
          org: {
            id: org.id,
            slug: 'refunds',
            name: 'Refunds',
            preset: 'startup',
            unit_level_names: ['Business unit'],
            data_region: 'ap-south-1',
            sso_enabled: false,
            created_at: '2026-10-15T08:00:00.000Z',
          },
          role: 'owner',
          status: 'active',
          expires_at: null,
        },
      ],
      unit_roles: [],
    });
    expect(me).not.toHaveProperty('personal_agent');
  });

  it('formats guest expiry and handles no orgs', () => {
    const expires = new Date(Date.UTC(2027, 0, 1));
    const me = toMe(user, [{ ...org, role: 'guest', expires_at: expires }]);
    expect(me.orgs[0]).toMatchObject({ role: 'guest', expires_at: '2027-01-01T00:00:00.000Z' });
    expect(toMe(user, []).orgs).toEqual([]);
  });
});
