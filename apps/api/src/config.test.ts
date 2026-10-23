import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const DB = { DATABASE_URL: 'postgres://x' };
const WORKOS = {
  WORKOS_API_KEY: 'sk_test_SECRETKEY',
  WORKOS_CLIENT_ID: 'client_123',
  WORKOS_COOKIE_PASSWORD: 'P'.repeat(40),
  WORKOS_REDIRECT_URI: 'http://localhost:3000/v1/auth/callback',
};

describe('loadConfig', () => {
  it('uses the documented defaults (doc 07 §7.1, doc 11 §11.7)', () => {
    expect(loadConfig(DB)).toEqual({
      databaseUrl: 'postgres://x',
      port: 4000,
      logLevel: 'info',
      userPerMinute: 600,
      orgPerMinute: 6000,
      webOrigin: 'http://localhost:3000',
      secureCookies: true,
      runtime: { appToolsUrl: 'http://localhost:4200/mcp' },
      llm: {
        // The runtime's tiers: strong (the primary), fast, then the fallbacks.
        models: [
          'nvidia/nemotron-3-super-120b-a12b:free',
          'nvidia/nemotron-3.5-lightning:free',
          'google/gemma-4-31b-it:free',
          'google/gemma-4-26b-a4b-it:free',
        ],
        tiers: {
          'nvidia/nemotron-3-super-120b-a12b:free': 'strong',
          'nvidia/nemotron-3.5-lightning:free': 'fast',
          'google/gemma-4-31b-it:free': 'fallback',
          'google/gemma-4-26b-a4b-it:free': 'fallback',
        },
        perMinute: 60,
      },
    });
  });

  it('runtime: off without RUNTIME_URL; with it, both signing keys are required', () => {
    const key = 'k'.repeat(32);
    expect(loadConfig(DB).runtime.url).toBeUndefined();
    expect(() => loadConfig({ ...DB, RUNTIME_URL: 'http://rt:7070/v1' })).toThrow(
      /RUNTIME_JWT_KEY, TOOL_TOKEN_KEY/,
    );
    expect(() => loadConfig({ ...DB, TOOL_TOKEN_KEY: 'short' })).toThrow(/at least 32/);
    expect(
      loadConfig({
        ...DB,
        RUNTIME_URL: 'http://rt:7070/v1/',
        RUNTIME_JWT_KEY: key,
        TOOL_TOKEN_KEY: key,
        APP_TOOLS_URL: 'http://tools:4200/mcp',
      }).runtime,
    ).toEqual({
      url: 'http://rt:7070/v1',
      jwtKey: key,
      toolTokenKey: key,
      appToolsUrl: 'http://tools:4200/mcp',
    });
  });

  it('reads overrides', () => {
    const config = loadConfig({
      ...DB,
      PORT: '4010',
      RATE_LIMIT_USER_PER_MINUTE: '5',
      RATE_LIMIT_ORG_PER_MINUTE: '50',
      WEB_ORIGIN: 'https://app.parallelflow.app/',
      COOKIE_DOMAIN: 'ParallelFlow.App',
    });
    expect(config).toMatchObject({
      port: 4010,
      userPerMinute: 5,
      orgPerMinute: 50,
      webOrigin: 'https://app.parallelflow.app',
      cookieDomain: 'parallelflow.app',
    });
  });

  it('fails without DATABASE_URL or with a bad number, without echoing values', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL is not set/);
    expect(() => loadConfig({ ...DB, PORT: 'abc' })).toThrow('PORT must be a positive integer');
  });

  describe('WEB_ORIGIN and COOKIE_DOMAIN', () => {
    it.each([
      ['http://evil.example', /https/],
      ['https://app.example.com/path', /no path/],
      ['not a url', /absolute URL/],
    ])('rejects %s', (origin, message) => {
      expect(() => loadConfig({ ...DB, WEB_ORIGIN: origin })).toThrow(message);
    });

    it('rejects a malformed cookie domain', () => {
      expect(() => loadConfig({ ...DB, COOKIE_DOMAIN: 'bad domain;' })).toThrow(/COOKIE_DOMAIN/);
    });
  });

  describe('WorkOS', () => {
    it('is off without keys, even with the default redirect URI', () => {
      const config = loadConfig({ ...DB, WORKOS_REDIRECT_URI: WORKOS.WORKOS_REDIRECT_URI });
      expect(config.workos).toBeUndefined();
    });

    it('reads all four settings; http://localhost turns Secure off', () => {
      const config = loadConfig({ ...DB, ...WORKOS });
      expect(config.workos).toEqual({
        apiKey: WORKOS.WORKOS_API_KEY,
        clientId: 'client_123',
        cookiePassword: WORKOS.WORKOS_COOKIE_PASSWORD,
        redirectUri: WORKOS.WORKOS_REDIRECT_URI,
      });
      expect(config.secureCookies).toBe(false);
      const prod = loadConfig({
        ...DB,
        ...WORKOS,
        WORKOS_REDIRECT_URI: 'https://api.parallelflow.app/v1/auth/callback',
      });
      expect(prod.secureCookies).toBe(true);
    });

    it('refuses partial configuration, naming only the missing variables', () => {
      let message = '';
      try {
        loadConfig({ ...DB, WORKOS_API_KEY: WORKOS.WORKOS_API_KEY });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(
        /partly configured.*WORKOS_CLIENT_ID, WORKOS_COOKIE_PASSWORD, WORKOS_REDIRECT_URI/,
      );
      expect(message).not.toContain('SECRETKEY');
    });

    it('requires a cookie password of at least 32 characters, without echoing it', () => {
      let message = '';
      try {
        loadConfig({ ...DB, ...WORKOS, WORKOS_COOKIE_PASSWORD: 'short-SECRET' });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toBe('WORKOS_COOKIE_PASSWORD must be at least 32 characters');
    });

    it('requires https for a non-local redirect URI', () => {
      expect(() =>
        loadConfig({ ...DB, ...WORKOS, WORKOS_REDIRECT_URI: 'http://api.parallelflow.app/cb' }),
      ).toThrow(/WORKOS_REDIRECT_URI must use https/);
    });
  });
});
