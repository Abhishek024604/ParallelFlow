import { randomBytes } from 'node:crypto';

// Request ids (doc 05 §5.5 step 1, doc 07 §7.1). An upstream id (load balancer, the web app) is kept
// when it is well formed, so one id follows a request across services. Anything else is replaced:
// the id is logged, so it must not carry arbitrary client text.

export const REQUEST_ID_HEADER = 'X-Request-Id';
const WELL_FORMED = /^[A-Za-z0-9._:-]{1,128}$/;

/** UUIDv7 (RFC 9562): 48-bit Unix ms timestamp, version 7, variant 10, random rest. Sortable. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function resolveRequestId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? undefined : incoming;
  return value && WELL_FORMED.test(value) ? value : uuidv7();
}
