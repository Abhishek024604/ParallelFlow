import type { AccessLogEntry, Logger } from '@parallelflow/observability';
import type { NextFunction, Request, Response } from 'express';
import { type QueryStats, trackQueries } from '@parallelflow/db';
import { initState } from './request-context.js';
import { REQUEST_ID_HEADER, resolveRequestId } from './request-id.js';

// Step 1 (doc 05 §5.5): assign the request id, echo it, and write one access-log line when the
// response finishes. The line holds only AccessLogEntry fields: no URL (query strings can carry
// tokens), no headers, no body.

/** `/v1/projects/:projectId/…` for matched routes; never the raw path. */
function routeTemplate(req: Request): string {
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : 'unmatched';
}

export function requestPipelineStart(logger: Logger, clock: () => number = Date.now) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = clock();
    const state = initState(req, resolveRequestId(req.headers['x-request-id']), startedAt);
    res.setHeader(REQUEST_ID_HEADER, state.requestId);
    // Database round trips of this request (counts and time only, never SQL), as a Server-Timing
    // header for the browser's network panel and in the access log.
    const db: QueryStats = { roundTrips: 0, ms: 0 };
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => Response;
    res.writeHead = ((...args: unknown[]) => {
      if (!res.headersSent) {
        res.setHeader(
          'Server-Timing',
          `db;desc="${db.roundTrips} round trips";dur=${db.ms.toFixed(0)}, total;dur=${Math.max(0, clock() - startedAt)}`,
        );
      }
      return writeHead(...args);
    }) as Response['writeHead'];

    res.on('finish', () => {
      const entry: AccessLogEntry = {
        request_id: state.requestId,
        method: req.method,
        route: routeTemplate(req),
        status: res.statusCode,
        latency_ms: Math.max(0, clock() - startedAt),
        db_round_trips: db.roundTrips,
        db_ms: Math.round(db.ms),
      };
      if (state.principal) entry.user_id = state.principal.userId;
      if (state.orgId) entry.org_id = state.orgId;
      if (state.code) entry.code = state.code;
      if (state.errName) entry.err_name = state.errName;
      if (state.errCode) entry.err_code = state.errCode;
      if (res.statusCode >= 500) logger.error(entry, 'request');
      else logger.info(entry, 'request');
    });
    trackQueries(db, () => next());
  };
}
