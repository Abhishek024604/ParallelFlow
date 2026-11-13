import { fileKey, parseFileKey } from '@parallelflow/db';
import { describe, expect, it } from 'vitest';
import { ARENA_FILE_TEXT_MAX, cutText } from './db.js';

describe('arena.file helpers', () => {
  it('reads F-keys the way the playbook writes them', () => {
    expect(parseFileKey('F-3')).toBe(3);
    expect(parseFileKey(' f3 ')).toBe(3);
    expect(parseFileKey('F 12')).toBe(12);
    expect(parseFileKey('F-0')).toBeNull();
    expect(parseFileKey('spec.md')).toBeNull();
    expect(parseFileKey('F-3 spec')).toBeNull();
    expect(fileKey(7)).toBe('F-7');
  });

  it('cuts a long file and says so', () => {
    expect(cutText('short', 10)).toEqual({ content: 'short', truncated: false });
    const long = cutText('x'.repeat(ARENA_FILE_TEXT_MAX + 5), ARENA_FILE_TEXT_MAX);
    expect(long.truncated).toBe(true);
    expect(long.content).toHaveLength(ARENA_FILE_TEXT_MAX + 1);
    expect(long.note).toContain('first 40,000 of 40,005 characters');
  });
});
