import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ProblemSchema } from '@parallelflow/contracts';
import { MembershipInactiveError, NotVisibleError } from '@parallelflow/db';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiError, toProblem } from './errors.js';

const RID = 'req-1';

function pgError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

describe('toProblem', () => {
  it('keeps an ApiError as is, with required_permission on 403', () => {
    const { status, problem } = toProblem(
      new ApiError(403, 'FORBIDDEN', { detail: 'Observer', requiredPermission: 'cap arena.post' }),
      RID,
    );
    expect(status).toBe(403);
    expect(problem).toEqual({
      type: 'urn:parallelflow:problem:forbidden',
      title: 'Not permitted',
      status: 403,
      code: 'FORBIDDEN',
      detail: 'Observer',
      request_id: RID,
      required_permission: 'cap arena.post',
    });
  });

  it('maps @parallelflow/db membership errors: not visible → 404, inactive → 403', () => {
    expect(toProblem(new NotVisibleError(), RID).problem).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(toProblem(new MembershipInactiveError(), RID).problem).toMatchObject({
      status: 403,
      code: 'MEMBERSHIP_INACTIVE',
    });
  });

  it('maps Zod errors to 400 with errors[]', () => {
    const parsed = z.object({ name: z.string() }).safeParse({ name: 1 });
    const { problem } = toProblem(parsed.error, RID);
    expect(problem).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(problem.errors).toEqual([{ field: 'name', message: expect.any(String) }]);
  });

  it('maps Nest HTTP exceptions and body-parser errors without echoing their messages', () => {
    expect(toProblem(new NotFoundException('Cannot GET /v1/secret?token=x'), RID).problem).toEqual({
      type: 'urn:parallelflow:problem:not_found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Not found.',
      request_id: RID,
    });
    expect(toProblem(new BadRequestException('x'), RID).status).toBe(400);
    expect(toProblem(new PayloadTooLargeException(), RID).problem.code).toBe('VALIDATION_FAILED');
    const parse = Object.assign(new SyntaxError('Unexpected token s in {"secret"'), {
      type: 'entity.parse.failed',
      status: 400,
    });
    const mapped = toProblem(parse, RID);
    expect(mapped.problem).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(JSON.stringify(mapped.problem)).not.toContain('secret');
  });

  it('maps known Postgres errors safely and never echoes SQL or values', () => {
    const rls = toProblem(pgError('42501', 'new row violates row-level security for "tasks"'), RID);
    expect(rls.problem).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const dup = toProblem(pgError('23505', 'duplicate key (email)=(a@b.test)'), RID);
    expect(dup.problem).toMatchObject({ status: 409, code: 'ALREADY_EXISTS' });
    expect(JSON.stringify(dup.problem)).not.toContain('a@b.test');
    expect(toProblem(pgError('40001', 'serialization'), RID).problem.code).toBe('CONFLICT');
  });

  it('turns anything else into a generic 500 and keeps only name and SQLSTATE for the log', () => {
    const plain = toProblem(new TypeError('cannot read secret of undefined'), RID);
    expect(plain.status).toBe(500);
    expect(plain.problem.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(plain.problem)).not.toContain('secret');
    expect(plain.internal).toEqual({ name: 'TypeError' });

    const sql = toProblem(pgError('22P02', 'invalid input syntax: "secret"'), RID);
    expect(sql.problem.code).toBe('INTERNAL_ERROR');
    expect(sql.internal).toEqual({ name: 'Error', code: '22P02' });
    expect(toProblem('a string', RID).internal).toEqual({ name: 'string' });
  });

  it('passes extra headers through (Retry-After)', () => {
    const { headers } = toProblem(
      new ApiError(429, 'RATE_LIMITED', { headers: { 'Retry-After': '7' } }),
      RID,
    );
    expect(headers).toEqual({ 'Retry-After': '7' });
  });

  it('always produces a body that matches the OpenAPI Problem schema', () => {
    const errors: unknown[] = [
      new ApiError(409, 'IDEMPOTENCY_KEY_REUSED'),
      new NotVisibleError(),
      new MembershipInactiveError(),
      new Error('boom'),
      pgError('42501', 'rls'),
      null,
    ];
    for (const err of errors) {
      expect(ProblemSchema.safeParse(toProblem(err, RID).problem).success).toBe(true);
    }
  });
});
