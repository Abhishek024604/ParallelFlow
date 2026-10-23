// NestJS modular monolith (HTTP + adapter dispatch), doc 05 §5.4.
export const workspace = '@parallelflow/api' as const;

export { createApp } from './app.js';
export type { ApiOptions, AuthOptions } from './app.js';
export type { IdentityProvider } from './identity/identity-provider.js';
export { WorkosIdentityProvider } from './identity/workos-provider.js';
export { NoSessionVerifier, Public } from './pipeline/auth.js';
export type { SessionVerifier } from './pipeline/auth.js';
export { Caller, DbTx, Idempotent, OrgScoped, ProjectScoped } from './pipeline/decorators.js';
export { ApiError } from './pipeline/errors.js';
export type { CallerContext, Principal } from './pipeline/request-context.js';
export { ZodPipe } from './pipeline/validation.js';
