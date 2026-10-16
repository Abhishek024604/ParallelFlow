import { describe, expect, it } from 'vitest';
import { loginHints } from './auth.controller.js';

describe('GET /auth/login hints', () => {
  it('passes only allowlisted screen and provider values', () => {
    expect(loginHints('sign-up', undefined)).toEqual({ screen: 'sign-up' });
    expect(loginHints('sign-in', ['x'])).toEqual({ screen: 'sign-in' });
    expect(loginHints(undefined, 'google')).toEqual({ provider: 'google' });
    expect(loginHints('admin', 'github')).toEqual({});
  });
});
