import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { type DynamicModule, type INestApplication, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Database } from '@saras/db';
import { createLogger, type Logger } from '@saras/observability';
import type { RuntimeClient, ToolToken, ToolTokenInput } from '@saras/runtime-client';
import { AGENT_TURNS, type AgentTurns } from './agent/agent-turns.js';
import { AiTurnLimiter, TurnBroadcaster } from './agent/broadcaster.js';
import { TurnRunner } from './agent/turn-runner.js';
import { PROGRESS_JOBS, ProgressJobs } from './progress/progress-jobs.js';
import { DbTurnStore } from './agent/turn-store.js';
import { ArenaTurnsController } from './agent/turns.controller.js';
import {
  ArenaArtifactsController,
  PrivateArtifactsController,
} from './artifacts/artifacts.controller.js';
import { ArenasController } from './arenas/arenas.controller.js';
import { BridgeController } from './bridge/bridge.controller.js';
import { ArenaFilesController, PrivateFilesController } from './files/files.controller.js';
import { ArenaChatController } from './arenas/messages.controller.js';
import { LoopController } from './loop/loop.controller.js';
import { CatalogueController, RolesController } from './roles/roles.controller.js';
import { HealthController } from './health/health.controller.js';
import { AuthController, WEB_SESSION } from './identity/auth.controller.js';
import { deriveKeys } from './identity/crypto.js';
import type { IdentityProvider } from './identity/identity-provider.js';
import { MeController } from './identity/me.controller.js';
import { NotificationsController } from './notifications/notifications.controller.js';
import { InvitesController } from './invites/invites.controller.js';
import { InviteManageController } from './invites/manage.controller.js';
import type { Mailer } from './mail/mailer.js';
import { ArenaRepos } from './repo/git.js';
import { RepoController } from './repo/repo.controller.js';
import { PrivateController } from './private/private.controller.js';
import { DEFAULT_SESSION_LIMITS, type SessionLimits } from './identity/session.js';
import { WorkosSessionVerifier } from './identity/session-verifier.js';
import { RefreshCoalescer, RevokedSessions, type WebSessionDeps } from './identity/web-session.js';
import { AuthGuard, NoSessionVerifier, type SessionVerifier } from './pipeline/auth.js';
import { IdempotencyStore } from './pipeline/idempotency.js';
import { PipelineInterceptor } from './pipeline/pipeline.interceptor.js';
import { ProblemFilter } from './pipeline/problem.filter.js';
import { DEFAULT_RATE_LIMITS, RateLimiter, type RateLimitOptions } from './pipeline/rate-limit.js';
import { READ_CACHE, ReadCache } from './pipeline/read-cache.js';
import { requestPipelineStart } from './pipeline/request-log.js';
import {
  ARENA_REPOS,
  CLOCK,
  type Clock,
  DATABASE,
  INVITE_KEY,
  LOGGER,
  MAILER,
  RATE_LIMITS,
  SESSION_VERIFIER,
  WEB_ORIGIN,
} from './pipeline/tokens.js';

/** Web login with WorkOS AuthKit (F01-01). */
export interface AuthOptions {
  /** WorkosIdentityProvider in production; a fake in tests. */
  provider: IdentityProvider;
  /** WORKOS_COOKIE_PASSWORD: HKDF input for the session MAC and login-state keys. */
  cookiePassword: string;
  /** Off only for an API on http://localhost (config.ts). */
  secureCookies: boolean;
  /** Domain attribute of `saras_csrf` (COOKIE_DOMAIN). */
  cookieDomain?: string;
  /** Tests only. Default 12 h absolute / 2 h idle (doc 10 §10.3). */
  sessionLimits?: Partial<SessionLimits>;
}

export interface ApiOptions {
  /** App-role database (DATABASE_URL). Checked with assertAppRole() before anything else. */
  db: Database;
  /**
   * Web login: the WorkOS session verifier plus /auth/login, /auth/callback and /auth/logout.
   * Unset = nobody can sign in (401 on every authenticated route); there is no backdoor.
   */
  auth?: AuthOptions;
  /** The web app (WEB_ORIGIN): CORS with credentials, and where login redirects. Required with auth. */
  webOrigin?: string;
  /** A custom verifier instead of `auth` (pipeline tests). */
  sessionVerifier?: SessionVerifier;
  logger?: Logger;
  rateLimits?: Partial<RateLimitOptions>;
  clock?: Clock;
  /**
   * The agent runtime (RIC v0.2). Unset = AI is not connected: @AI turns fail fast with
   * RUNTIME_NOT_CONFIGURED.
   */
  runtime?: { client: RuntimeClient; mintToolToken: (input: ToolTokenInput) => ToolToken };
  /**
   * The in-process read cache of GET responses (pipeline/read-cache.ts). Off by default (tests);
   * main.ts turns it on. Single instance only.
   */
  readCache?: boolean;
  /**
   * Key for invite link secrets (INVITE_LINK_KEY). Default: derived from the cookie password, so
   * links survive restarts; a random per-process key without auth (tests).
   */
  inviteKey?: string;
  /** Folder of the arenas' git repositories (ARENA_REPOS_DIR). Default: a temp folder (tests). */
  repoDir?: string;
  /** Outgoing email (SMTP_URL). Unset = no emails; links are copied by hand. */
  mailer?: Mailer;
  /** Extra controllers. Tests use this for pipeline-only routes; shipped code does not. */
  controllers?: Type[];
}

/** Where invite links point when no WEB_ORIGIN is given (tests); config.ts has the same default. */
const DEFAULT_WEB_ORIGIN = 'http://localhost:3000';

/** Largest JSON body: an artifact version (doc 10 §10.5). Per-field limits are Zod's job. */
const JSON_BODY_LIMIT = '2mb';
/**
 * Raw uploads (POST /private/files, /projects/{id}/files): application/octet-stream only, 10 MB
 * (Phase A, in-database content). JSON keeps its own parser and limit.
 */
const UPLOAD_BODY_LIMIT = '10mb';

// Nest modules are marker classes; providers are added by apiModule() below.
@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class ApiModule {}

/** Headers the web app may send, and read, cross-origin (doc 07 §7.1). */
const CORS_ALLOWED_HEADERS = ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'];
const CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Retry-After',
  'Idempotent-Replayed',
];

function webSession(options: ApiOptions, logger: Logger, clock: Clock): WebSessionDeps | undefined {
  const { auth } = options;
  if (!auth) return undefined;
  if (options.sessionVerifier) throw new Error('Pass either auth or sessionVerifier, not both');
  if (!options.webOrigin) throw new Error('auth needs webOrigin (WEB_ORIGIN)');
  return {
    db: options.db,
    provider: auth.provider,
    keys: deriveKeys(auth.cookiePassword),
    cookies: {
      secure: auth.secureCookies,
      ...(auth.cookieDomain && { csrfDomain: auth.cookieDomain }),
    },
    limits: { ...DEFAULT_SESSION_LIMITS, ...auth.sessionLimits },
    webOrigin: options.webOrigin,
    clock,
    logger,
    revoked: new RevokedSessions(),
    refreshes: new RefreshCoalescer(),
  };
}

function agentTurns(
  options: ApiOptions,
  logger: Logger,
  clock: Clock,
  cache: ReadCache,
): AgentTurns {
  const broadcaster = new TurnBroadcaster();
  const runner = new TurnRunner({
    store: new DbTurnStore(options.db, cache),
    client: options.runtime?.client,
    mintToolToken: options.runtime?.mintToolToken,
    broadcaster,
    logger,
  });
  return { runner, broadcaster, limiter: new AiTurnLimiter(30, 60_000, clock) };
}

/** HMAC key for invite links: its own secret, else one derived from the cookie password. */
function inviteKey(options: ApiOptions): Buffer {
  const secret = options.inviteKey ?? options.auth?.cookiePassword;
  if (!secret) return randomBytes(32);
  return createHmac('sha256', secret).update('saras invite links v1').digest();
}

function apiModule(options: ApiOptions, logger: Logger): DynamicModule {
  const clock = options.clock ?? Date.now;
  const session = webSession(options, logger, clock);
  const cache = new ReadCache(options.readCache ?? false, clock);
  const turns = agentTurns(options, logger, clock, cache);
  const repos = new ArenaRepos(
    options.repoDir ?? mkdtempSync(join(tmpdir(), 'saras-repos-')),
    logger,
  );
  const progress = new ProgressJobs({
    db: options.db,
    runner: turns.runner,
    repos,
    logger,
    cache,
  });
  const verifier =
    (session && new WorkosSessionVerifier(session)) ??
    options.sessionVerifier ??
    new NoSessionVerifier();
  return {
    module: ApiModule,
    controllers: [
      HealthController,
      MeController,
      NotificationsController,
      ArenasController,
      ArenaChatController,
      LoopController,
      RepoController,
      CatalogueController,
      RolesController,
      ArenaTurnsController,
      InvitesController,
      InviteManageController,
      PrivateController,
      BridgeController,
      PrivateArtifactsController,
      ArenaArtifactsController,
      PrivateFilesController,
      ArenaFilesController,
      ...(session ? [AuthController] : []),
      ...(options.controllers ?? []),
    ],
    providers: [
      { provide: DATABASE, useValue: options.db },
      { provide: SESSION_VERIFIER, useValue: verifier },
      ...(session ? [{ provide: WEB_SESSION, useValue: session }] : []),
      { provide: LOGGER, useValue: logger },
      { provide: AGENT_TURNS, useValue: turns },
      { provide: PROGRESS_JOBS, useValue: progress },
      { provide: READ_CACHE, useValue: cache },
      { provide: RATE_LIMITS, useValue: { ...DEFAULT_RATE_LIMITS, ...options.rateLimits } },
      { provide: CLOCK, useValue: clock },
      { provide: WEB_ORIGIN, useValue: options.webOrigin ?? DEFAULT_WEB_ORIGIN },
      { provide: INVITE_KEY, useValue: inviteKey(options) },
      { provide: MAILER, useValue: options.mailer ?? null },
      { provide: ARENA_REPOS, useValue: repos },
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
  if (options.webOrigin) {
    // One fixed origin, never a wildcard: credentials (cookies) are allowed.
    app.enableCors({
      origin: options.webOrigin,
      credentials: true,
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      allowedHeaders: CORS_ALLOWED_HEADERS,
      exposedHeaders: CORS_EXPOSED_HEADERS,
      maxAge: 600,
    });
  }
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('raw', { limit: UPLOAD_BODY_LIMIT, type: 'application/octet-stream' });
  app.setGlobalPrefix('v1');
  await app.init();
  return app;
}
