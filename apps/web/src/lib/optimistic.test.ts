import { describe, expect, it } from 'vitest';
import { unsettled } from './optimistic';

describe('optimistic sidebar entries', () => {
  it('drops an entry once the server lists it, so a later delete removes it for good', () => {
    const chat = { id: 'c1', title: 'New chat' };
    const pending = [chat];
    // Created: the server now lists it, the optimistic copy goes.
    expect(unsettled(pending, [chat])).toEqual([]);
    // Not listed yet: kept, and the same array (no re-render).
    expect(unsettled(pending, [])).toBe(pending);
  });
});
