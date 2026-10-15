import { describe, expect, it } from 'vitest';
import { resolveRequestId, uuidv7 } from './request-id.js';

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('has version 7, variant 10 and the timestamp in the first 48 bits', () => {
    const now = Date.UTC(2026, 9, 16, 9, 30);
    const id = uuidv7(now);
    expect(id).toMatch(V7);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(now);
  });

  it('sorts by time and is unique', () => {
    const a = uuidv7(1000);
    const b = uuidv7(2000);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7())).size).toBe(1000);
  });
});

describe('resolveRequestId', () => {
  it.each(['abc-123', '1-67891233-abcdef012345678912345678', 'a.b_c:d', 'x'.repeat(128)])(
    'keeps a well-formed incoming id: %s',
    (id) => {
      expect(resolveRequestId(id)).toBe(id);
    },
  );

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['too long', 'x'.repeat(129)],
    ['spaces', 'has space'],
    ['other characters', 'Root=1-abc'],
    ['log injection', 'ok\n{"level":60}'],
    ['repeated header', ['a', 'b']],
  ])('generates a UUIDv7 when the incoming id is %s', (_label, id) => {
    expect(resolveRequestId(id)).toMatch(V7);
  });
});
