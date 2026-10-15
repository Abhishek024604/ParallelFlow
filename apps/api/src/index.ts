// NestJS modular monolith (HTTP + adapter dispatch), doc 05 §5.4.
export const workspace = '@saras/api' as const;

export { createApp } from './app.js';
export type { ApiOptions } from './app.js';
export { NoSessionVerifier, Public } from './pipeline/auth.js';
export type { SessionVerifier } from './pipeline/auth.js';
export { Caller, DbTx, Idempotent, OrgScoped, ProjectScoped } from './pipeline/decorators.js';
export { ApiError } from './pipeline/errors.js';
export type { CallerContext, Principal } from './pipeline/request-context.js';
export { ZodPipe } from './pipeline/validation.js';
