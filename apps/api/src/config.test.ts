import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

describe('loadConfig', () => {
  it('uses the documented defaults (doc 07 §7.1)', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://x' })).toEqual({
      databaseUrl: 'postgres://x',
      port: 4000,
      logLevel: 'info',
      userPerMinute: 600,
      orgPerMinute: 6000,
    });
  });

  it('reads overrides', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      PORT: '4010',
      RATE_LIMIT_USER_PER_MINUTE: '5',
      RATE_LIMIT_ORG_PER_MINUTE: '50',
    });
    expect(config).toMatchObject({ port: 4010, userPerMinute: 5, orgPerMinute: 50 });
  });

  it('fails without DATABASE_URL or with a bad number, without echoing values', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is not set/);
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', PORT: 'abc' })).toThrow(
      'PORT must be a positive integer',
    );
  });
});
