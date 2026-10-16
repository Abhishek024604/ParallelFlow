import { describe, expect, it } from 'vitest';
import { matchesType } from './sniff.js';

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'utf8')] : p)));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('matchesType (magic bytes)', () => {
  it.each([
    ['image/png', bytes(PNG, [0, 0, 0, 13])],
    ['image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0])],
    ['image/gif', bytes('GIF89a', [1, 0])],
    ['image/webp', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')],
    ['application/pdf', bytes('%PDF-1.7\n')],
    ['text/plain', bytes('hello')],
    ['text/markdown', bytes('# Goal\n\nShip it.')],
    ['text/csv', bytes('a,b\n1,2\n')],
    ['application/json', bytes('{"a":1}')],
  ] as const)('accepts a real %s', (type, buf) => {
    expect(matchesType(buf, type)).toBe(true);
  });

  it.each([
    ['image/png', bytes('%PDF-1.7')],
    ['image/jpeg', bytes(PNG)],
    ['application/pdf', bytes('<html>')],
    ['image/webp', bytes('RIFF', [0, 0, 0, 0], 'AVI ')],
    ['text/plain', bytes(PNG)],
    ['text/plain', bytes('a', [0], 'b')],
    ['text/plain', bytes([0xc3, 0x28])],
    ['text/markdown', bytes('<!DOCTYPE html><script>x</script>')],
    ['text/markdown', bytes('  <svg onload="x">')],
    ['text/plain', bytes('<?xml version="1.0"?><svg/>')],
    ['application/json', bytes('{not json')],
  ] as const)('rejects a disguised %s', (type, buf) => {
    expect(matchesType(buf, type)).toBe(false);
  });
});
