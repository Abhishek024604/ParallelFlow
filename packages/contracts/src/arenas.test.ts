import { describe, expect, it } from 'vitest';
import {
  CreateArenaSchema,
  formatInviteToken,
  InviteEmailSchema,
  MAX_INVITE_EMAILS,
  parseInviteToken,
} from './arenas.js';

const ORG = '0192f0a0-0000-7000-8000-00000000a001';
const SECRET = 'A'.repeat(42) + '_';

describe('invite tokens', () => {
  it('round-trips <org id>.<secret>', () => {
    const token = formatInviteToken(ORG.toUpperCase(), SECRET);
    expect(token).toBe(`${ORG}.${SECRET}`);
    expect(parseInviteToken(token)).toEqual({ orgId: ORG, secret: SECRET });
  });

  it.each([
    ['empty', ''],
    ['no dot', `${ORG}${SECRET}`],
    ['short secret', `${ORG}.${SECRET.slice(1)}`],
    ['long secret', `${ORG}.${SECRET}A`],
    ['padding', `${ORG}.${SECRET.slice(1)}=`],
    ['upper-case id', `${ORG.toUpperCase()}.${SECRET}`],
    ['nil id', `00000000-0000-0000-0000-000000000000.${SECRET}`],
    ['accept suffix', `${ORG}.${SECRET}:accept`],
    ['path', `../${ORG}.${SECRET}`],
  ])('rejects %s', (_, token) => {
    expect(parseInviteToken(token)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseInviteToken(undefined)).toBeNull();
    expect(parseInviteToken(['x'])).toBeNull();
  });
});

describe('CreateArenaSchema', () => {
  it('trims, lower-cases and de-duplicates', () => {
    const body = CreateArenaSchema.parse({
      name: '  Interview Prep ',
      description: '   ',
      invite_emails: ['Riya@Adva.ai', ' riya@adva.ai', 'karan@adva.ai'],
    });
    expect(body).toEqual({
      name: 'Interview Prep',
      description: undefined,
      invite_emails: ['riya@adva.ai', 'karan@adva.ai'],
    });
  });

  it('defaults invite_emails to an empty list', () => {
    expect(CreateArenaSchema.parse({ name: 'X' }).invite_emails).toEqual([]);
  });

  it.each([
    ['blank name', { name: '   ' }],
    ['long name', { name: 'x'.repeat(81) }],
    ['long description', { name: 'X', description: 'x'.repeat(501) }],
    ['bad email', { name: 'X', invite_emails: ['not-an-email'] }],
    [
      'too many emails',
      {
        name: 'X',
        invite_emails: Array.from({ length: MAX_INVITE_EMAILS + 1 }, (_, i) => `p${i}@a.io`),
      },
    ],
    ['unknown field', { name: 'X', org_id: ORG }],
  ])('rejects %s', (_, body) => {
    expect(CreateArenaSchema.safeParse(body).success).toBe(false);
  });

  it('validates one email chip', () => {
    expect(InviteEmailSchema.safeParse(' Neha@Adva.ai ').data).toBe('neha@adva.ai');
    expect(InviteEmailSchema.safeParse('neha@').success).toBe(false);
  });
});
