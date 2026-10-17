import { describe, expect, it } from 'vitest';
import { notificationValues, shortPreview } from './notifications.js';

const base = {
  orgId: 'o',
  projectId: 'p',
  type: 'tag' as const,
  title: 'Asha mentioned you',
  resourceType: 'message',
  resourceId: 'm',
  deepLink: '/arena/p',
  dedupeKey: 'mention:m',
};

describe('notifications', () => {
  it('cuts the preview to one short line', () => {
    expect(shortPreview('  hello\n\n world ')).toBe('hello world');
    expect(shortPreview('')).toBeNull();
    const long = shortPreview('x'.repeat(500));
    expect(long).toHaveLength(140);
    expect(long?.endsWith('…')).toBe(true);
  });

  it('never notifies the actor and dedupes recipients', () => {
    const v = notificationValues({
      ...base,
      actor: { type: 'user', id: 'u1' },
      recipients: { userIds: ['u1', 'u2', 'u2', 'u3'] },
    });
    expect(v.userIds).toEqual(['u2', 'u3']);
    expect(v.actorUser).toBe('u1');
    expect(v.requiresAction).toBe(false);
    expect(v.dedupeKey).toBe('mention:m');
  });

  it('keeps member and role recipients for the query, and an AI actor is not a person', () => {
    const v = notificationValues({
      ...base,
      actor: { type: 'agent', id: 'a1' },
      requiresAction: true,
      recipients: { members: true },
    });
    expect(v.userIds).toBeNull();
    expect(v.actorUser).toBeNull();
    expect(v.requiresAction).toBe(true);
  });
});
