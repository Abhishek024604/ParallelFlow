import { randomInt } from 'node:crypto';
import { HANDLE_PATTERN } from '@parallelflow/contracts';

// New accounts get a display name and a unique handle derived from the identity provider's profile.
// Handles follow HANDLE_PATTERN (^[a-z0-9_-]{3,30}$); `users.handle` is citext UNIQUE.

const BASE_MAX = 24;
const SUFFIX_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DISPLAY_NAME_MAX = 80;

/** A valid handle from the email's local part, e.g. `Priya.K+test@x.io` → `priya-k-test`. */
export function handleBase(email: string): string {
  const local = email.split('@')[0] ?? '';
  let base = local
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, BASE_MAX)
    .replace(/[-_]+$/g, '');
  if (base.length < 3) base = `user${base ? `-${base}` : ''}`;
  return base;
}

/** Attempt 0 is the base itself; later attempts add a random 4-character suffix. */
export function handleCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += SUFFIX_CHARS[randomInt(SUFFIX_CHARS.length)];
  return `${base}-${suffix}`;
}

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/** First and last name from the provider, else the email's local part. Trimmed, 1–80 characters. */
export function displayNameFor(profile: {
  email: string;
  firstName: string | null;
  lastName: string | null;
}): string {
  const full = [profile.firstName, profile.lastName]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
  const name = full || (profile.email.split('@')[0] ?? '').trim() || 'New user';
  return [...name].slice(0, DISPLAY_NAME_MAX).join('');
}
