import { describe, expect, it } from 'vitest';
import { chainFor, classify, route, type RouterConfig } from './router.js';

const config: RouterConfig = {
  fast: ['fast-1'],
  strong: ['strong-1'],
  fallbacks: ['fb-1', 'fb-2', 'strong-1'],
};

describe('parallelflow/auto routing', () => {
  it('sends quick chat to FAST and documents, code and summaries to STRONG with their thinking level', () => {
    expect(
      route({ reason: 'user', text: 'thanks, sounds good!', toolResults: 0 }, config),
    ).toMatchObject({
      model: 'fast-1',
      thinkingLevel: 'off',
      state: { tier: 'fast', job: 'chat' },
    });
    expect(
      route({ reason: 'user', text: 'Write a spec for checkout', toolResults: 0 }, config),
    ).toMatchObject({
      model: 'strong-1',
      thinkingLevel: 'high',
    });
    expect(classify('fix this bug in the endpoint')).toBe('code');
    expect(
      route({ reason: 'user', text: 'x', job: 'summary', toolResults: 0 }, config),
    ).toMatchObject({
      model: 'strong-1',
      thinkingLevel: 'medium',
    });
    expect(route({ reason: 'direct', text: '', toolResults: 0 }, config).model).toBe('strong-1');
  });

  it('keeps the turn on its model, and moves a tool-heavy FAST turn to STRONG', () => {
    const state = { tier: 'fast' as const, job: 'chat' as const };
    expect(
      route(
        { reason: 'continuation', text: 'hi', toolResults: 1, previous: 'fast-1', state },
        config,
      ).model,
    ).toBe('fast-1');
    expect(
      route(
        { reason: 'continuation', text: 'hi', toolResults: 3, previous: 'fast-1', state },
        config,
      ),
    ).toMatchObject({
      model: 'strong-1',
      state: { tier: 'strong' },
    });
  });

  it('falls back in order on overload or rate limit, and skips models without credentials', () => {
    const state = { tier: 'strong' as const, job: 'document' as const };
    expect(chainFor('strong', config)).toEqual(['strong-1', 'fast-1', 'fb-1', 'fb-2']);
    const retry = (failed: string, error = '429 Too Many Requests') =>
      route(
        { reason: 'retry', text: '', toolResults: 0, failed: { model: failed, error }, state },
        config,
      ).model;
    expect(retry('strong-1')).toBe('fast-1');
    expect(retry('fast-1')).toBe('fb-1');
    expect(retry('fb-1', 'provider overloaded')).toBe('fb-2');
    // A non-capacity error retries on the same model.
    expect(retry('fb-1', 'invalid tool arguments')).toBe('fb-1');
    // Unavailable models are skipped.
    expect(
      route(
        { reason: 'user', text: 'write the plan', toolResults: 0 },
        config,
        (id) => id !== 'strong-1',
      ).model,
    ).toBe('fast-1');
  });
});
