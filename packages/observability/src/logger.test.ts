import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

function memory(): { lines: string[]; stream: Writable } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { lines, stream };
}

describe('createLogger', () => {
  it('writes structured JSON lines', () => {
    const { lines, stream } = memory();
    createLogger({ destination: stream }).info({ request_id: 'r1', status: 200 }, 'request');
    expect(JSON.parse(lines[0]!)).toMatchObject({ request_id: 'r1', status: 200, msg: 'request' });
  });

  it('redacts bodies, credentials, idempotency keys and content that slip into a log call', () => {
    const { lines, stream } = memory();
    createLogger({ destination: stream }).info(
      {
        body: { secret: 'BODY-SECRET' },
        req: {
          headers: {
            authorization: 'Bearer AUTH-SECRET',
            cookie: 'saras_session=COOKIE-SECRET',
            'idempotency-key': 'IDEM-SECRET',
          },
        },
        token: 'TOKEN-SECRET',
        message: { content: 'CONTENT-SECRET' },
        prompt: 'PROMPT-SECRET',
      },
      'oops',
    );
    const out = lines.join('');
    for (const secret of ['BODY', 'AUTH', 'COOKIE', 'IDEM', 'TOKEN', 'CONTENT', 'PROMPT']) {
      expect(out).not.toContain(`${secret}-SECRET`);
    }
    expect(out).toContain('[redacted]');
  });

  it('never serialises error messages or stacks', () => {
    const { lines, stream } = memory();
    createLogger({ destination: stream }).error(
      { err: new Error('duplicate key (email)=(x@secret.test)') },
      'failed',
    );
    expect(lines.join('')).not.toContain('secret.test');
  });
});
