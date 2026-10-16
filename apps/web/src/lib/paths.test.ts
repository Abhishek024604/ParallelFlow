import { describe, expect, it } from 'vitest';
import { authErrorMessage, loginUrl, safeReturnPath, signInPath } from './paths';
import { applyToCookieHeader, parseSetCookie } from './set-cookie';

describe('return paths and sign-in links', () => {
  it.each([
    ['/join/abc.def', '/join/abc.def'],
    ['/arena/123?x=1', '/arena/123?x=1'],
    ['https://evil.example/', '/arena'],
    ['//evil.example', '/arena'],
    ['/\\evil.example', '/arena'],
    ['/a\nb', '/arena'],
    ['/sign-in?return_to=/x', '/arena'],
    [undefined, '/arena'],
  ])('safeReturnPath(%j) → %s', (raw, expected) => {
    expect(safeReturnPath(raw)).toBe(expected);
  });

  it('builds same-origin AuthKit login links', () => {
    const link = loginUrl({ returnTo: '/join/t', provider: 'google' });
    expect(link.startsWith('/v1/auth/login?')).toBe(true);
    const google = new URL(link, 'http://web.test');
    expect(google.searchParams.get('provider')).toBe('google');
    expect(google.searchParams.get('return_to')).toBe('/join/t');
    const signUp = new URL(loginUrl({ returnTo: '//x', screen: 'sign-up' }), 'http://web.test');
    expect(signUp.searchParams.get('screen')).toBe('sign-up');
    expect(signUp.searchParams.get('return_to')).toBe('/arena');
    expect(signInPath('/join/t')).toBe('/sign-in?return_to=%2Fjoin%2Ft');
  });

  it('explains auth errors in plain words', () => {
    expect(authErrorMessage(undefined)).toBeNull();
    expect(authErrorMessage('email_unverified')).toMatch(/verify your email/);
    expect(authErrorMessage('something-new')).toMatch(/try again/);
  });
});

describe('Set-Cookie pass-through', () => {
  const now = Date.parse('2026-10-16T00:00:00Z');

  it('reads refreshed and cleared cookies', () => {
    expect(parseSetCookie('saras_session=s1.abc; Path=/; HttpOnly; SameSite=Lax', now)).toEqual({
      name: 'saras_session',
      value: 's1.abc',
    });
    expect(
      parseSetCookie('saras_csrf=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', now),
    ).toEqual({ name: 'saras_csrf', value: null });
    expect(parseSetCookie('a=b; Max-Age=0', now)).toEqual({ name: 'a', value: null });
    expect(parseSetCookie('garbage', now)).toBeNull();
  });

  it('rewrites the Cookie request header', () => {
    expect(
      applyToCookieHeader('saras_session=old; saras_csrf=c; other=1', [
        { name: 'saras_session', value: 'new' },
        { name: 'saras_csrf', value: null },
      ]),
    ).toBe('saras_session=new; other=1');
  });
});
