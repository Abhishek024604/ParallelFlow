import { randomBytes } from 'node:crypto';
import { parseInviteToken } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { inviteSecretHash } from '../arenas/naming.js';
import { inviteSecretFor, inviteTokenFor, isDerived } from './links.js';

const ORG = '01a14942-37ef-7b65-af3f-0528bbf18680';
const ID = '01a14942-37ef-7b65-af3f-0528bbf18681';

describe('invite link secrets', () => {
  it('derives the same valid token again from the id, and a different one per key or id', () => {
    const key = randomBytes(32);
    const token = inviteTokenFor(key, ORG, ID);
    expect(parseInviteToken(token)).toEqual({ orgId: ORG, secret: inviteSecretFor(key, ID) });
    expect(inviteTokenFor(key, ORG, ID)).toBe(token);
    expect(inviteTokenFor(randomBytes(32), ORG, ID)).not.toBe(token);
    expect(inviteSecretFor(key, ORG)).not.toBe(inviteSecretFor(key, ID));
  });

  it('recognises only its own hashes', () => {
    const key = randomBytes(32);
    expect(isDerived(key, ID, inviteSecretHash(inviteSecretFor(key, ID)))).toBe(true);
    expect(isDerived(key, ID, inviteSecretHash('random'))).toBe(false);
  });
});
