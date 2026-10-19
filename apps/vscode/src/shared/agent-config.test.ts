import { PROFILE_COMMANDS, PROFILE_SKILLS } from '@saras/pi-saras';
import { describe, expect, it } from 'vitest';
import {
  arenaBrief,
  CODER_COMMANDS,
  CODER_SKILLS,
  parseAgentConfig,
  routerFrom,
} from './agent-config.js';

describe('saras-agent config', () => {
  it('builds the saras/auto router from the proxy model tiers', () => {
    expect(
      routerFrom([
        { id: 'v/strong', tier: 'strong' },
        { id: 'v/fast', tier: 'fast' },
        { id: 'v/spare', tier: 'fallback' },
      ]),
    ).toEqual({ fast: ['v/fast'], strong: ['v/strong'], fallbacks: ['v/spare'] });
    expect(routerFrom([{ id: 'v/one', tier: 'strong' }])).toEqual({
      fast: ['v/one'],
      strong: ['v/one'],
      fallbacks: [],
    });
    // An older server without tiers: no routing, the agent uses one model.
    expect(routerFrom([{ id: 'v/one' }])).toBeUndefined();
  });

  it('parses leniently and never fails the agent', () => {
    expect(parseAgentConfig(undefined)).toEqual({ agentName: 'AI' });
    expect(parseAgentConfig('not json')).toEqual({ agentName: 'AI' });
    expect(
      parseAgentConfig(JSON.stringify({ agentName: 'Bo', router: { strong: ['s', 3] } })),
    ).toEqual({ agentName: 'Bo', router: { fast: ['s'], strong: ['s'], fallbacks: [] } });
  });

  it('keeps the coder skills and commands equal to pi-saras', () => {
    expect([...CODER_SKILLS]).toEqual([...PROFILE_SKILLS.coder]);
    expect([...CODER_COMMANDS]).toEqual([...PROFILE_COMMANDS.coder]);
  });

  it('describes the linked arena', () => {
    expect(arenaBrief({ name: 'Checkout', cycle: 2, stage: 'BUILD' })).toBe(
      'Checkout: cycle 2, stage BUILD',
    );
    expect(arenaBrief({ name: 'Checkout', cycle: null })).toBe('Checkout');
  });
});
