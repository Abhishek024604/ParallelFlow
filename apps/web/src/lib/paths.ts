import { HOME_PATH, PUBLIC_API_URL } from './config';

// Sign-in links and return paths. The API validates `return_to` again (ADR-032: relative path or
// WEB_ORIGIN only); this keeps the web app from building links it would reject.

/** A same-site path like `/join/abc`, else the home path. */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) return HOME_PATH;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return HOME_PATH;
  // Control characters and backslashes are never part of our paths.
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || ch === '\\') return HOME_PATH;
  }
  if (raw.startsWith('/sign-in')) return HOME_PATH;
  return raw;
}

export interface LoginOptions {
  returnTo: string;
  screen?: 'sign-up' | 'sign-in';
  provider?: 'google';
}

/** The API's hosted login (WorkOS AuthKit), coming back to `returnTo`. */
export function loginUrl(options: LoginOptions, apiUrl = PUBLIC_API_URL): string {
  const url = new URL(`${apiUrl}/v1/auth/login`);
  url.searchParams.set('return_to', safeReturnPath(options.returnTo));
  if (options.provider) url.searchParams.set('provider', options.provider);
  else if (options.screen) url.searchParams.set('screen', options.screen);
  return url.toString();
}

/** The web sign-in page, coming back to `returnTo`. */
export function signInPath(returnTo: string): string {
  const params = new URLSearchParams({ return_to: safeReturnPath(returnTo) });
  return `/sign-in?${params.toString()}`;
}

/** Friendly copy for the callback's `?auth_error=` reasons (ADR-032). */
export function authErrorMessage(reason: unknown): string | null {
  switch (reason) {
    case undefined:
    case null:
    case '':
      return null;
    case 'denied':
      return 'Sign-in was cancelled. Try again when you are ready.';
    case 'email_unverified':
      return 'Please verify your email address first, then sign in again.';
    case 'invalid_state':
      return 'That sign-in link expired or was opened in another browser. Please try again.';
    case 'invalid_code':
      return 'That sign-in attempt did not go through. Please try again.';
    case 'account_deactivated':
      return 'This account has been deactivated. Contact the person who runs your arena.';
    default:
      return 'Something went wrong while signing in. Please try again.';
  }
}
