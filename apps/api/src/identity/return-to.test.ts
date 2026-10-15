import { describe, expect, it } from 'vitest';
import { safeReturnTo, webRoot } from './return-to.js';

const WEB = 'http://localhost:3000';
const ROOT = 'http://localhost:3000/';

describe('safeReturnTo', () => {
  it.each([
    ['/arenas/42', 'http://localhost:3000/arenas/42'],
    ['/join?invite=abc#top', 'http://localhost:3000/join?invite=abc#top'],
    ['http://localhost:3000/settings', 'http://localhost:3000/settings'],
    ['/', ROOT],
  ])('keeps %s on the web app', (raw, expected) => {
    expect(safeReturnTo(raw, WEB)).toBe(expected);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['another site with our path', 'https://evil.example/arenas'],
    ['another port', 'http://localhost:4000/v1/me'],
    ['another scheme', 'https://localhost:3000/'],
    ['protocol-relative', '//evil.example/x'],
    ['backslash trick', '/\\evil.example'],
    ['backslash trick 2', '\\\\evil.example'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,hi'],
    ['credentials', 'http://user:pw@localhost:3000/'],
    ['control characters', '/a\r\nSet-Cookie: x=1'],
    ['tab', '/\t/evil.example'],
    ['relative without slash', 'arenas'],
    ['empty', ''],
    ['too long', `/${'a'.repeat(2048)}`],
    ['not a string', ['/a', '/b']],
    ['missing', undefined],
  ])('falls back to the web root for %s', (_label, raw) => {
    expect(safeReturnTo(raw, WEB)).toBe(ROOT);
  });

  it('webRoot is the origin with a trailing slash', () => {
    expect(webRoot('https://app.example.com')).toBe('https://app.example.com/');
  });
});
