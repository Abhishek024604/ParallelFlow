import { describe, expect, it } from 'vitest';
import { mentionedUserIds } from './mentions.js';

const members = [
  { user_id: 'u1', display_name: 'Ann' },
  { user_id: 'u2', display_name: 'Anna Lee' },
  { user_id: 'u3', display_name: 'Ravi' },
];

describe('mentions', () => {
  it('finds teammates named with @, whole names only', () => {
    expect(mentionedUserIds('@Anna Lee can you check?', members)).toEqual(['u2']);
    expect(mentionedUserIds('thanks @ann and @RAVI!', members)).toEqual(['u1', 'u3']);
    expect(mentionedUserIds('mail ann@ravi.com', members)).toEqual([]);
    expect(mentionedUserIds('@AI summarise', members)).toEqual([]);
  });
});

describe('first-name mentions', () => {
  const team = [
    { user_id: 'a', display_name: 'Asha Rao' },
    { user_id: 'b', display_name: 'Ben Ode' },
    { user_id: 'c', display_name: 'Ben Ito' },
  ];
  it('matches a unique first name in any case, not a shared one', () => {
    expect(mentionedUserIds('hey @asha, can you look?', team)).toEqual(['a']);
    expect(mentionedUserIds('@ben please', team)).toEqual([]);
    expect(mentionedUserIds('@Ben Ito please', team)).toEqual(['c']);
    expect(mentionedUserIds('@ashanti hi', team)).toEqual([]);
  });
});
