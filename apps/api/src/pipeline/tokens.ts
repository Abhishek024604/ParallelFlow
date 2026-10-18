// DI tokens. Constructor parameters always name their token with @Inject: the build does not emit
// decorator metadata (esbuild/tsx/vitest), so Nest cannot infer types.

export const DATABASE = Symbol('DATABASE');
export const SESSION_VERIFIER = Symbol('SESSION_VERIFIER');
export const LOGGER = Symbol('LOGGER');
export const RATE_LIMITS = Symbol('RATE_LIMITS');
export const CLOCK = Symbol('CLOCK');
/** The web app's origin (WEB_ORIGIN): invite links point at it. */
export const WEB_ORIGIN = Symbol('WEB_ORIGIN');

/** Milliseconds since the epoch. Injected so tests control rate-limit windows. */
export type Clock = () => number;
/** Key for invite link secrets (invites/links.ts). A Buffer; never logged. */
export const INVITE_KEY = Symbol('INVITE_KEY');
/** Outgoing email (mail/mailer.ts), or null when SMTP_URL is not set. */
export const MAILER = Symbol('MAILER');
/** Per-arena git repositories (repo/git.ts). */
export const ARENA_REPOS = Symbol('ARENA_REPOS');
/** Extension bearer tokens (ext/bearer.ts). */
export const BEARER_TOKENS = Symbol('BEARER_TOKENS');
/** The LLM proxy (llm/proxy.ts). */
export const LLM_PROXY = Symbol('LLM_PROXY');
