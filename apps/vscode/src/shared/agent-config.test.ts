import { PROFILE_COMMANDS, PROFILE_SKILLS } from '@parallelflow/pi-parallelflow';
import { describe, expect, it } from 'vitest';
import {
  arenaBrief,
  claudeTokenFrom,
  CODER_COMMANDS,
  CODER_SKILLS,
  parseAgentConfig,
  routerFrom,
} from './agent-config.js';

describe('parallelflow-agent config', () => {
  it('builds the parallelflow/auto router from the proxy model tiers', () => {
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
    expect(parseAgentConfig(JSON.stringify({ mode: 'architect' }))).toEqual({
      agentName: 'AI',
      mode: 'architect',
    });
    expect(parseAgentConfig(JSON.stringify({ mode: 'root' }))).toEqual({ agentName: 'AI' });
  });

  it('keeps the coder skills and commands equal to pi-parallelflow', () => {
    expect([...CODER_SKILLS]).toEqual([...PROFILE_SKILLS.coder]);
    expect([...CODER_COMMANDS]).toEqual([...PROFILE_COMMANDS.coder]);
  });

  it('describes the linked arena', () => {
    expect(arenaBrief({ name: 'Checkout', cycle: 2, stage: 'BUILD' })).toBe(
      'Checkout: cycle 2, stage BUILD',
    );
    expect(arenaBrief({ name: 'Checkout', cycle: null })).toBe('Checkout');
  });

  it('picks the Claude token out of a terminal copy', () => {
    const token = `sk-ant-oat01-${'aB3_-'.repeat(20)}AA`;
    expect(claudeTokenFrom(token)).toEqual({ token });
    // Wrapped across lines, with spaces, quotes and the surrounding output.
    const wrapped = `Your token:
  ${token.slice(0, 50)}
${token.slice(50)}  
`;
    expect(claudeTokenFrom(wrapped)).toEqual({ token });
    expect(claudeTokenFrom(`"${token}"`)).toEqual({ token });
    expect(claudeTokenFrom('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toMatchObject({
      error: expect.stringContaining('API key'),
    });
    expect(claudeTokenFrom('sk-ant-oat01-short')).toMatchObject({
      error: expect.stringContaining('cut short'),
    });
    expect(claudeTokenFrom('hello')).toHaveProperty('error');
  });
});
