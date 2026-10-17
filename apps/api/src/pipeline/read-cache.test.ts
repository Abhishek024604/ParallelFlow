import { describe, expect, it } from 'vitest';
import { projectTag, ReadCache, userTag } from './read-cache.js';

describe('ReadCache', () => {
  const setup = (enabled = true) => {
    let now = 1_000;
    const cache = new ReadCache(enabled, () => now, 30_000);
    return { cache, advance: (ms: number) => (now += ms) };
  };
  const tags = [userTag('u1'), projectTag('p1')];

  it('answers a stored read until the TTL ends', () => {
    const { cache, advance } = setup();
    cache.set('k', { a: 1 }, cache.snapshot(tags));
    expect(cache.get('k')).toEqual({ body: { a: 1 } });
    advance(30_000);
    expect(cache.get('k')).toBeUndefined();
  });

  it('drops entries when one of their tags is invalidated', () => {
    const { cache } = setup();
    cache.set('k', 1, cache.snapshot(tags));
    cache.set('other', 2, cache.snapshot([userTag('u2')]));
    cache.invalidate(projectTag('p1'));
    expect(cache.get('k')).toBeUndefined();
    expect(cache.get('other')).toEqual({ body: 2 });
  });

  it('never stores a read that raced a write', () => {
    const { cache } = setup();
    const before = cache.snapshot(tags);
    cache.invalidate(userTag('u1')); // a write committed while the read ran
    cache.set('k', 'stale', before);
    expect(cache.get('k')).toBeUndefined();
  });

  it('does nothing when disabled', () => {
    const { cache } = setup(false);
    cache.set('k', 1, cache.snapshot(tags));
    expect(cache.get('k')).toBeUndefined();
  });
});
