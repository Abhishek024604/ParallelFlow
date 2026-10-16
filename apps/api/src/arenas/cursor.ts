// Message cursors: an opaque base64url encoding of (created_at, id), so pages and polls keep a stable
// order even when two messages share a timestamp. created_at keeps Postgres' microseconds; a JS Date
// would round them to milliseconds and skip or repeat rows.

export interface MessageCursor {
  /** UTC, microseconds: 2026-10-16T10:02:00.123456Z */
  createdAt: string;
  id: string;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function encodeCursor(cursor: MessageCursor): string {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

/** Strict decode; anything else is null. */
export function decodeCursor(value: string): MessageCursor | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value)) return null;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const [createdAt, id, ...rest] = text.split('|');
  if (rest.length || !createdAt || !id || !TIMESTAMP.test(createdAt) || !UUID.test(id)) return null;
  if (Number.isNaN(Date.parse(createdAt))) return null;
  return { createdAt, id };
}
