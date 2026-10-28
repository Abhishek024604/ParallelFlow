import { createHmac, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appJwt,
  InstallationTokens,
  SignedValues,
  TOKEN_MARGIN_MS,
  verifyWebhookSignature,
} from './github-app.js';

describe('github app', () => {
  it('verifies webhook signatures over the raw body', () => {
    const body = Buffer.from('{"zen":"Keep it logically awesome."}');
    const good = `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`;
    expect(verifyWebhookSignature('webhook-secret', body, good)).toBe(true);
    expect(verifyWebhookSignature('other-secret', body, good)).toBe(false);
    expect(verifyWebhookSignature('webhook-secret', Buffer.from('{}'), good)).toBe(false);
    expect(verifyWebhookSignature('webhook-secret', body, 'sha256=abc')).toBe(false);
    expect(verifyWebhookSignature('webhook-secret', body, undefined)).toBe(false);
  });

  it('signs an RS256 app JWT that the public key verifies', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = appJwt('12345', privateKey, 1_700_000_000_000);
    const [head = '', body = '', sig = ''] = jwt.split('.');
    const ok = verify(
      'sha256',
      Buffer.from(`${head}.${body}`),
      publicKey,
      Buffer.from(sig, 'base64url'),
    );
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: '12345' });
  });

  it('caches installation tokens until five minutes before they expire', async () => {
    let now = 0;
    let mints = 0;
    const tokens = new InstallationTokens(
      async () => {
        mints += 1;
        return { token: `t${mints}`, expiresAt: now + 60 * 60_000 };
      },
      () => now,
    );
    const [a, b] = await Promise.all([tokens.get(1, 2), tokens.get(1, 2)]);
    expect([a, b, mints]).toEqual(['t1', 't1', 1]);
    now = 60 * 60_000 - TOKEN_MARGIN_MS - 1;
    expect(await tokens.get(1, 2)).toBe('t1');
    now += 1;
    expect(await tokens.get(1, 2)).toBe('t2');
    expect(await tokens.get(1, 3)).toBe('t3');
    tokens.forget(1);
    expect(await tokens.get(1, 2)).toBe('t4');
  });

  it('signs state bound to its kind and expiry, and rejects tampering', () => {
    let now = 1000;
    const values = new SignedValues(Buffer.alloc(32, 7), () => now);
    const state = values.sign('install', { p: 'project', u: 'user' }, 60_000);
    expect(values.verify('install', state)).toMatchObject({ p: 'project', u: 'user' });
    expect(values.verify('grant', state)).toBeNull();
    const [data = '', mac = ''] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({ p: 'other', u: 'user', k: 'install', x: now + 60_000 }),
    ).toString('base64url');
    expect(values.verify('install', `${forged}.${mac}`)).toBeNull();
    expect(values.verify('install', `${data}.${mac}x`)).toBeNull();
    expect(new SignedValues(Buffer.alloc(32, 8), () => now).verify('install', state)).toBeNull();
    now += 60_000;
    expect(values.verify('install', state)).toBeNull();
  });
});
