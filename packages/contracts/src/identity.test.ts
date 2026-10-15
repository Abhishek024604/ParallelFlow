import { describe, expect, it } from 'vitest';
import { UpdateMeSchema } from './identity.js';

describe('UpdateMeSchema (PATCH /me)', () => {
  it('trims the display name and lower-cases the handle', () => {
    expect(UpdateMeSchema.parse({ display_name: '  Priya K ', handle: ' Priya_K ' })).toEqual({
      display_name: 'Priya K',
      handle: 'priya_k',
    });
  });

  it.each([
    ['empty body', {}],
    ['blank display name', { display_name: '   ' }],
    ['long display name', { display_name: 'a'.repeat(81) }],
    ['short handle', { handle: 'ab' }],
    ['long handle', { handle: 'a'.repeat(31) }],
    ['handle with dot', { handle: 'pri.ya' }],
    ['handle with space', { handle: 'pri ya' }],
    ['unknown field', { handle: 'priya', email: 'x@y.z' }],
    ['wrong type', { display_name: 5 }],
  ])('rejects %s', (_label, body) => {
    expect(UpdateMeSchema.safeParse(body).success).toBe(false);
  });

  it('accepts one field alone and 80-character names', () => {
    expect(UpdateMeSchema.parse({ display_name: 'a'.repeat(80) }).display_name).toHaveLength(80);
    expect(UpdateMeSchema.parse({ handle: 'a-b_c' })).toEqual({ handle: 'a-b_c' });
  });
});
