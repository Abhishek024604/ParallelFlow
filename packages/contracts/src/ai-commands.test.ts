import { describe, expect, it } from 'vitest';
import { aiCommandQuery, aiCommandsFor, aiCommandText, parseAiCommand } from './ai-commands.js';

describe('AI commands', () => {
  it('parses a leading command of the surface only', () => {
    expect(parseAiCommand('/spec checkout flow\nmore', 'arena')).toEqual({
      name: 'spec',
      args: 'checkout flow',
    });
    expect(parseAiCommand('/plan', 'private')).toBeNull();
    expect(parseAiCommand('/nope x', 'arena')).toBeNull();
    expect(parseAiCommand('see /spec', 'arena')).toBeNull();
  });

  it('drops a leading @AI before a command', () => {
    expect(aiCommandText('@AI /review the login page', 'arena')).toBe('/review the login page');
    expect(aiCommandText('@ai, /spec x', 'arena')).toBe('/spec x');
    expect(aiCommandText('@AI write a spec', 'arena')).toBeNull();
    expect(aiCommandText('/shrug', 'arena')).toBeNull();
  });

  it('opens the menu only for a / typed at the very start', () => {
    expect(aiCommandQuery('/sp', 3)).toBe('sp');
    expect(aiCommandQuery('/', 1)).toBe('');
    expect(aiCommandQuery('/spec x', 7)).toBeNull();
    expect(aiCommandQuery('hi /sp', 6)).toBeNull();
    expect(aiCommandsFor('private').map((c) => c.name)).toEqual(['spec', 'summarize', 'tasks']);
  });
});
