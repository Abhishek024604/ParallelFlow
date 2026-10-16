'use client';

import type { FieldError } from '@saras/contracts';

// API calls from the browser (mutations), same-origin through the /v1 proxy (next.config.ts), so the
// cookies go along without CORS. Unsafe methods echo the readable `saras_csrf` cookie in
// X-CSRF-Token (ADR-032). Errors are problem+json.

const CSRF_COOKIE = 'saras_csrf';

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
  let res: Response;
  try {
    res = await fetch(`/v1${path}`, {
      method: 'POST',
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
    throw new ProblemError(
      0,
      'NETWORK',
      'Could not reach Saras. Check your connection and try again.',
    );
  }
  if (res.status === 204) return undefined as T;
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

/** Signs out (POST /auth/logout) and goes to `next`. Goes there even if the call fails. */
export async function signOut(next = '/sign-in'): Promise<void> {
  try {
    await apiPost('/auth/logout');
  } catch {
    // The cookies may already be gone; the sign-in page sorts it out.
  }
  window.location.assign(next);
}
