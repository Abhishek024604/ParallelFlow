import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, IdempotencyKeySchema, ProblemSchema, problemType } from './problem.js';

const apiReference = readFileSync(
  new URL('../../../docs/07_API_Reference.md', import.meta.url),
  'utf8',
);

describe('error codes', () => {
  it('match the table in doc 07 §7.4 exactly', () => {
    const section = apiReference.split('## 7.4 Error codes')[1]!.split('\n## ')[0]!;
    const documented = new Set(
      section
        .split('\n')
        .filter((line) => /^\| \d{3} \|/.test(line))
        .flatMap((line) => [...line.split('|')[2]!.matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]!)),
    );
    expect([...documented].sort()).toEqual([...ERROR_CODES].sort());
  });
});

describe('ProblemSchema', () => {
  it('accepts a full problem with a urn type', () => {
    const problem = {
      type: problemType('FORBIDDEN'),
      title: 'Forbidden',
      status: 403,
      code: 'FORBIDDEN',
      detail: 'Your role is Observer.',
      request_id: '0192f1d2-0000-7000-8000-000000000000',
      required_permission: 'cap arena.post',
      errors: [{ field: 'body', message: 'Required' }],
    };
    expect(ProblemSchema.parse(problem)).toEqual(problem);
    expect(problem.type).toBe('urn:parallelflow:problem:forbidden');
  });

  it('rejects unknown codes and extra fields', () => {
    const base = { type: problemType('NOT_FOUND'), title: 'Not found', status: 404 };
    expect(ProblemSchema.safeParse({ ...base, code: 'NOPE' }).success).toBe(false);
    expect(ProblemSchema.safeParse({ ...base, code: 'NOT_FOUND', stack: 'x' }).success).toBe(false);
  });
});

describe('IdempotencyKeySchema', () => {
  it.each(['a', 'x'.repeat(128), '3f2c-9a1e_~!'])('accepts %s', (key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(['', 'x'.repeat(129), 'has space', 'tab\t', 'ünicode'])('rejects %j', (key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});
