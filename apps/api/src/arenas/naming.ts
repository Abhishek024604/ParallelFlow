import { createHash, randomBytes } from 'node:crypto';

// Small pure helpers for arenas and invites: keys, slugs, initials, masked emails, token hashes.

const FALLBACK_KEY = 'AR';

/**
 * The arena key shown in badges ("IPP"): 2–4 upper-case letters from the name. Several words → their
 * initials; one word → its first three letters. Names without Latin letters get "AR". Each arena is
 * its own hidden org (ADR-029), so the key is unique within the org by construction.
 */
export function arenaKey(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let key = words.length >= 2 ? words.map((w) => w[0]).join('') : (words[0] ?? '').slice(0, 3);
  key = key.toUpperCase().slice(0, 4);
  return key.length >= 2 ? key : FALLBACK_KEY;
}

/** A random, URL-safe slug for the hidden org. Never shown in the UI. */
export function randomSlug(): string {
  return `a-${randomBytes(9).toString('hex')}`;
}

/** "Riya Sharma" → "RS", "abhishek" → "A". At most two letters. */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length >= 2 ? [parts[0]?.[0], parts[parts.length - 1]?.[0]] : [parts[0]?.[0]];
  return letters.filter(Boolean).join('').toUpperCase() || '?';
}

/** "riya@adva.ai" → "r***@adva.ai". The domain stays so people can tell which account to use. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** What `invitations.token_hash` stores: SHA-256 of the secret, hex. */
export function inviteSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}
