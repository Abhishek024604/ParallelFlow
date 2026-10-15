import { describe, expect, it } from 'vitest';
import { ApiError } from './errors.js';
import { canonicalJson, parseIdempotencyKey, requestHash } from './idempotency.js';

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('drops undefined properties like JSON does', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(undefined)).toBe('null');
  });
});

describe('requestHash', () => {
  const base = {
    method: 'POST',
    path: '/v1/projects/p/tasks',
    query: {},
    body: { title: 'x', n: 1 },
  };

  it('is stable for the same request, whatever the key order', () => {
    expect(requestHash(base)).toBe(requestHash({ ...base, body: { n: 1, title: 'x' } }));
    expect(requestHash(base)).toBe(requestHash({ ...base, method: 'post' }));
    expect(requestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the body, path, method or query', () => {
    const h = requestHash(base);
    expect(requestHash({ ...base, body: { title: 'y', n: 1 } })).not.toBe(h);
    expect(requestHash({ ...base, path: '/v1/projects/q/tasks' })).not.toBe(h);
    expect(requestHash({ ...base, method: 'PUT' })).not.toBe(h);
    expect(requestHash({ ...base, query: { dry: 'true' } })).not.toBe(h);
  });

  it('does not contain the body', () => {
    expect(requestHash({ ...base, body: { secret: 'S3CRET' } })).not.toContain('S3CRET');
  });
});

describe('parseIdempotencyKey', () => {
  const code = (header: string | string[] | undefined) => {
    try {
      parseIdempotencyKey(header);
      return 'ok';
    } catch (err) {
      return err instanceof ApiError ? `${err.status} ${err.code}` : String(err);
    }
  };

  it('accepts a valid key', () => {
    expect(parseIdempotencyKey('3f2c-9a1e')).toBe('3f2c-9a1e');
  });

  it('rejects a missing, empty, long, spaced or repeated key with 400 VALIDATION_FAILED', () => {
    for (const header of [undefined, '', 'x'.repeat(129), 'a b', ['a', 'b']]) {
      expect(code(header)).toBe('400 VALIDATION_FAILED');
    }
  });
});
