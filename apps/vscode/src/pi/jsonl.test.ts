import { describe, expect, it } from 'vitest';
import { JsonlDecoder, serializeJsonl } from './jsonl.js';

describe('JsonlDecoder', () => {
  it('splits on LF only and keeps U+2028/U+2029 inside records', () => {
    const d = new JsonlDecoder();
    const record = { text: 'a b c' };
    const lines = d.push(Buffer.from(serializeJsonl(record) + serializeJsonl({ n: 2 })));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(record);
  });

  it('strips CR, skips blank lines and buffers partial records', () => {
    const d = new JsonlDecoder();
    expect(d.push('{"a":1}\r\n\n{"b"')).toEqual(['{"a":1}']);
    expect(d.push(':2}\n')).toEqual(['{"b":2}']);
  });

  it('decodes multi-byte characters split across chunks', () => {
    const d = new JsonlDecoder();
    const bytes = Buffer.from('{"t":"é😀"}\n');
    const out = [...d.push(bytes.subarray(0, 8)), ...d.push(bytes.subarray(8))];
    expect(JSON.parse(out[0]!)).toEqual({ t: 'é😀' });
  });

  it('flushes a final unterminated record', () => {
    const d = new JsonlDecoder();
    expect(d.push('{"x":1}')).toEqual([]);
    expect(d.end()).toEqual(['{"x":1}']);
  });
});
