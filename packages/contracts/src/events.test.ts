import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  eventTopic,
  InvalidEventError,
  MAX_EVENT_BYTES,
  parseDomainEvent,
  withinEventSizeLimit,
} from './events.js';
import { UUID_V7_PATTERN, uuidv7 } from './ids.js';

const ORG = '0b9e7c1a-6f47-4f3e-9a2b-2f1d3c4b5a69';
const PROJECT = '5f0c3a4e-2b1d-4c8e-9f7a-6e5d4c3b2a19';
const ARENA = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';

function valid(overrides: Record<string, unknown> = {}) {
  return {
    id: uuidv7(),
    type: 'project.setup_completed',
    org_id: ORG,
    subject: PROJECT,
    actor: { type: 'user', id: PROJECT, on_behalf_of: null },
    time: new Date().toISOString(),
    trace_id: null,
    schema_version: 1,
    data: { project_id: PROJECT, arena_id: ARENA },
    ...overrides,
  };
}

describe('uuidv7', () => {
  it('is a sortable lower-case UUIDv7', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a).toMatch(UUID_V7_PATTERN);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 500 }, () => uuidv7())).size).toBe(500);
  });
});

describe('parseDomainEvent', () => {
  it('accepts a valid event of each registered type', () => {
    expect(parseDomainEvent(valid()).type).toBe('project.setup_completed');
    expect(
      parseDomainEvent(
        valid({
          type: 'member.invited',
          subject: ARENA,
          data: { invitation_id: ARENA, project_id: null },
        }),
      ).type,
    ).toBe('member.invited');
    expect(
      parseDomainEvent(
        valid({
          type: 'member.joined',
          subject: PROJECT,
          data: { user_id: PROJECT, invitation_id: null, project_id: PROJECT },
        }),
      ).type,
    ).toBe('member.joined');
    expect(EVENT_TYPES).toEqual(['project.setup_completed', 'member.invited', 'member.joined']);
  });

  it.each([
    ['unknown type', { type: 'project.deleted' }],
    ['content in data', { data: { project_id: PROJECT, arena_id: ARENA, body: 'secret text' } }],
    ['name instead of id', { data: { project_id: 'My project', arena_id: ARENA } }],
    ['extra envelope field', { message: 'hello' }],
    [
      'extra actor field',
      { actor: { type: 'user', id: null, on_behalf_of: null, email: 'a@b.c' } },
    ],
    ['non-v7 id', { id: PROJECT }],
    ['upper-case id', { id: uuidv7().toUpperCase() }],
    ['wrong schema version', { schema_version: 2 }],
    ['bad trace id', { trace_id: 'not-a-trace' }],
    ['bad time', { time: 'yesterday' }],
    ['missing data', { data: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => parseDomainEvent(valid(overrides))).toThrow(InvalidEventError);
  });

  it('caps the serialized size', () => {
    // A registered event cannot reach the cap today (ids only); the guard is for future types.
    expect(withinEventSizeLimit(valid())).toBe(true);
    expect(withinEventSizeLimit({ pad: 'x'.repeat(MAX_EVENT_BYTES) })).toBe(false);
    expect(() => parseDomainEvent(valid({ pad: 'x'.repeat(MAX_EVENT_BYTES) }))).toThrow(
      InvalidEventError,
    );
  });

  it('error names paths, never values', () => {
    try {
      parseDomainEvent(valid({ data: { project_id: 'TOP-SECRET', arena_id: ARENA } }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidEventError);
      expect((err as Error).message).toContain('data.project_id');
      expect((err as Error).message).not.toContain('TOP-SECRET');
    }
  });
});

describe('eventTopic', () => {
  it('is the part before the first dot', () => {
    expect(eventTopic('member.joined')).toBe('member');
    expect(eventTopic('project.setup_completed')).toBe('project');
  });
});
