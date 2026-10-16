import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from './cursor.js';

const CURSOR = {
  createdAt: '2026-10-16T10:02:00.123456Z',
  id: '0192f0a0-0000-7000-8000-00000000a001',
};

describe('message cursors', () => {
  it('round-trips (created_at, id) and is URL-safe', () => {
    const encoded = encodeCursor(CURSOR);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(encoded)).toEqual(CURSOR);
  });

  const raw = (text: string) => Buffer.from(text, 'utf8').toString('base64url');

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    ['no separator', raw(CURSOR.createdAt)],
    ['millisecond timestamp', raw(`2026-10-16T10:02:00.123Z|${CURSOR.id}`)],
    ['bad date', raw(`2026-13-45T10:02:00.123456Z|${CURSOR.id}`)],
    ['upper-case id', raw(`${CURSOR.createdAt}|${CURSOR.id.toUpperCase()}`)],
    ['extra part', raw(`${CURSOR.createdAt}|${CURSOR.id}|x`)],
    ['sql', raw(`${CURSOR.createdAt}'; --|${CURSOR.id}`)],
  ])('rejects %s', (_, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});
