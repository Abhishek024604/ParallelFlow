import { Writable } from 'node:stream';
import { uuidv7, type DomainEvent } from '@saras/contracts';
import { createLogger, type Logger } from '@saras/observability';

// Test helpers for the worker's unit and integration tests. Not exported from the package.

export function memoryLogger(): { logger: Logger; lines: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return {
    logger: createLogger({ destination: stream, level: 'debug' }),
    lines: () => chunks.join(''),
  };
}

export function joinedEvent(orgId: string, userId: string): DomainEvent<'member.joined'> {
  return {
    id: uuidv7(),
    type: 'member.joined',
    org_id: orgId,
    subject: userId,
    actor: { type: 'user', id: userId, on_behalf_of: null },
    time: new Date().toISOString(),
    trace_id: null,
    schema_version: 1,
    data: { user_id: userId, invitation_id: null, project_id: null },
  };
}
