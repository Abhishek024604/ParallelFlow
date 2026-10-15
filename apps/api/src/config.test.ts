import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const DB = { DATABASE_URL: 'postgres://x' };
const WORKOS = {
  WORKOS_API_KEY: 'sk_test_SECRETKEY',
  WORKOS_CLIENT_ID: 'client_123',
  WORKOS_COOKIE_PASSWORD: 'P'.repeat(40),
  WORKOS_REDIRECT_URI: 'http://localhost:4000/v1/auth/callback',
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
    });
  });

  it('reads overrides', () => {
    const config = loadConfig({
      ...DB,
      PORT: '4010',
      RATE_LIMIT_USER_PER_MINUTE: '5',
      RATE_LIMIT_ORG_PER_MINUTE: '50',
      WEB_ORIGIN: 'https://app.saras.app/',
      COOKIE_DOMAIN: 'Saras.App',
    });
    expect(config).toMatchObject({
      port: 4010,
      userPerMinute: 5,
      orgPerMinute: 50,
      webOrigin: 'https://app.saras.app',
      cookieDomain: 'saras.app',
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
        WORKOS_REDIRECT_URI: 'https://api.saras.app/v1/auth/callback',
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
        loadConfig({ ...DB, ...WORKOS, WORKOS_REDIRECT_URI: 'http://api.saras.app/cb' }),
      ).toThrow(/WORKOS_REDIRECT_URI must use https/);
    });
  });
});
