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
