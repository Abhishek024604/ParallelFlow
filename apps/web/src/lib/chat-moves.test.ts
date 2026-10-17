import { describe, expect, it } from 'vitest';
import { applyMoves, countDelta, pendingMoves } from './chat-moves';

const chats = [
  { id: 'c1', private_project_id: null },
  { id: 'c2', private_project_id: 'p1' },
];

describe('optimistic chat moves', () => {
  it('moves chats at once and adjusts project counts', () => {
    const moves = new Map([
      ['c1', 'p1'],
      ['c2', null],
    ]);
    expect(applyMoves(chats, moves).map((c) => c.private_project_id)).toEqual(['p1', null]);
    expect(countDelta('p1', chats, new Map([['c1', 'p1']]))).toBe(1);
    expect(countDelta('p1', chats, new Map([['c2', null]]))).toBe(-1);
  });

  it('drops an override once the server agrees', () => {
    const moves = new Map([['c1', 'p1']]);
    expect(pendingMoves(moves, chats).size).toBe(1);
    expect(pendingMoves(moves, [{ id: 'c1', private_project_id: 'p1' }]).size).toBe(0);
  });
});
