import { uuidv7 } from '@saras/contracts';

// UUIDv7 moved to @saras/contracts (F21-05: event ids use it too). Re-exported for existing callers.
export { uuidv7 };

// Request ids (doc 05 §5.5 step 1, doc 07 §7.1). An upstream id (load balancer, the web app) is kept
// when it is well formed, so one id follows a request across services. Anything else is replaced:
// the id is logged, so it must not carry arbitrary client text.

export const REQUEST_ID_HEADER = 'X-Request-Id';
const WELL_FORMED = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveRequestId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? undefined : incoming;
  return value && WELL_FORMED.test(value) ? value : uuidv7();
}
