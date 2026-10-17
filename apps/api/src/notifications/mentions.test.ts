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
