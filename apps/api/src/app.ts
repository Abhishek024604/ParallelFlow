import 'reflect-metadata';
import { type DynamicModule, type INestApplication, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Database } from '@saras/db';
import { createLogger, type Logger } from '@saras/observability';
import { HealthController } from './health/health.controller.js';
import { AuthGuard, NoSessionVerifier, type SessionVerifier } from './pipeline/auth.js';
import { IdempotencyStore } from './pipeline/idempotency.js';
import { PipelineInterceptor } from './pipeline/pipeline.interceptor.js';
import { ProblemFilter } from './pipeline/problem.filter.js';
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimitOptions } from './pipeline/rate-limit.js';
import { requestPipelineStart } from './pipeline/request-log.js';
import {
  CLOCK,
  type Clock,
  DATABASE,
  LOGGER,
  RATE_LIMITS,
  SESSION_VERIFIER,
} from './pipeline/tokens.js';

export interface ApiOptions {
  /** App-role database (DATABASE_URL). Checked with assertAppRole() before anything else. */
  db: Database;
  /** Unset = nobody can sign in (401 on every authenticated route) until F01-01 provides one. */
  sessionVerifier?: SessionVerifier;
  logger?: Logger;
  rateLimits?: Partial<RateLimitOptions>;
  clock?: Clock;
  /** Extra controllers. Tests use this for pipeline-only routes; shipped code does not. */
  controllers?: Type[];
}

/** Largest JSON body: an artifact version (doc 10 §10.5). Per-field limits are Zod's job. */
const JSON_BODY_LIMIT = '2mb';

// Nest modules are marker classes; providers are added by apiModule() below.
@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ApiModule {}

function apiModule(options: ApiOptions, logger: Logger): DynamicModule {
  return {
    module: ApiModule,
    controllers: [HealthController, ...(options.controllers ?? [])],
    providers: [
      { provide: DATABASE, useValue: options.db },
      { provide: SESSION_VERIFIER, useValue: options.sessionVerifier ?? new NoSessionVerifier() },
      { provide: LOGGER, useValue: logger },
      { provide: RATE_LIMITS, useValue: { ...DEFAULT_RATE_LIMITS, ...options.rateLimits } },
      { provide: CLOCK, useValue: options.clock ?? Date.now },
      RateLimiter,
      IdempotencyStore,
      // Order: guard (auth) → interceptor (limits, tenant, idempotency, tx) → pipes → handler.
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_INTERCEPTOR, useClass: PipelineInterceptor },
      { provide: APP_FILTER, useClass: ProblemFilter },
    ],
  };
}

/**
 * Builds the API (doc 05 §5.5). Refuses to start on a database role that can bypass RLS (ADR-030).
 * The caller owns `db` and destroys it after `app.close()`.
 */
export async function createApp(options: ApiOptions): Promise<INestApplication> {
  await options.db.assertAppRole();
  const logger = options.logger ?? createLogger({ name: 'api' });

  const app = await NestFactory.create<NestExpressApplication>(apiModule(options, logger), {
    // Nest's own logger prints exception messages and stacks; the access log replaces it.
    logger: false,
    bodyParser: false,
  });
  app.disable('x-powered-by');
  // Runs before body parsing and routing, so every response (even a 404) has a request id.
  app.use(requestPipelineStart(logger, options.clock));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.setGlobalPrefix('v1');
  await app.init();
  return app;
}
