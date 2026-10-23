'use client';

import type { FieldError } from '@parallelflow/contracts';

// API calls from the browser (mutations), same-origin through the /v1 proxy (next.config.ts), so the
// cookies go along without CORS. Unsafe methods echo the readable `parallelflow_csrf` cookie in
// X-CSRF-Token (ADR-032). Errors are problem+json.

const CSRF_COOKIE = 'parallelflow_csrf';
const NETWORK_DETAIL = 'Could not reach ParallelFlow. Check your connection and try again.';

export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(detail);
    this.name = 'ProblemError';
  }
}

function csrfToken(): string {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === CSRF_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return '';
}

export interface PostOptions {
  /** Sends a fresh Idempotency-Key (creating POSTs). */
  idempotencyKey?: string;
}

export async function apiPost<T>(
  path: string,
  body?: unknown,
  options: PostOptions = {},
): Promise<T> {
  return apiSend<T>('POST', path, body, options);
}

/** Any unsafe method (PATCH, PUT, DELETE, POST) with CSRF; 204 resolves to undefined. */
export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  options: PostOptions = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'X-CSRF-Token': csrfToken(),
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(options.idempotencyKey && { 'Idempotency-Key': options.idempotencyKey }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ProblemError(0, 'NETWORK', NETWORK_DETAIL);
  }
  if (res.status === 204) return undefined as T;
  return parse<T>(res);
}

/** JSON body for 2xx; ProblemError otherwise. */
async function parse<T>(res: Response): Promise<T> {
  const data: unknown = await res.json().catch(() => null);
  if (res.ok) return data as T;
  const problem = (data ?? {}) as { code?: string; detail?: string; errors?: FieldError[] };
  throw new ProblemError(
    res.status,
    problem.code ?? 'INTERNAL_ERROR',
    problem.detail ?? 'Something went wrong. Please try again.',
    problem.errors ?? [],
  );
}

/** Same-origin GET (reads that refresh a client view, e.g. polling the arena). */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      ...(signal && { signal }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProblemError(0, 'NETWORK', NETWORK_DETAIL);
  }
  return parse<T>(res);
}

/** Signs out (POST /auth/logout) and goes to `next`. Goes there even if the call fails. */
export async function signOut(next = '/sign-in'): Promise<void> {
  try {
    await apiPost('/auth/logout');
  } catch {
    // The cookies may already be gone; the sign-in page sorts it out.
  }
  window.location.assign(next);
}

/** GET a text body (an artifact version's markdown). */
export async function apiGetText(path: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(signal && { signal }),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ProblemError(0, 'NETWORK', NETWORK_DETAIL);
  }
  if (!res.ok) return parse<string>(res);
  return res.text();
}

/**
 * Uploads one file as the raw body (POST /private/files or /projects/{id}/files, Phase A), with
 * CSRF. `mimeType` must be on the allowlist; the API also checks the bytes.
 */
export async function apiUpload<T>(
  path: string,
  file: Blob,
  name: string,
  mimeType: string,
): Promise<T> {
  const query = new URLSearchParams({ name, mime_type: mimeType });
  let res: Response;
  try {
    res = await fetch(`/v1${path}?${query.toString()}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        'X-CSRF-Token': csrfToken(),
      },
      body: file,
    });
  } catch {
    throw new ProblemError(0, 'NETWORK', NETWORK_DETAIL);
  }
  return parse<T>(res);
}
