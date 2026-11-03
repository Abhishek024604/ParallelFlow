import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { type DynamicModule, type INestApplication, Module, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw } from 'express';
import { type Database, setArenaEventListener } from '@parallelflow/db';
import { createLogger, type Logger } from '@parallelflow/observability';
import type { RuntimeClient, ToolToken, ToolTokenInput } from '@parallelflow/runtime-client';
import { AGENT_TURNS, type AgentTurns } from './agent/agent-turns.js';
import { AiTurnLimiter, TurnBroadcaster } from './agent/broadcaster.js';
import { TurnRunner } from './agent/turn-runner.js';
import { ACTIVITY_JOBS, ActivityJobs } from './progress/activity-jobs.js';
import { MEMORY_JOBS, MemoryJobs } from './memory/memory-jobs.js';
import { DbTurnStore } from './agent/turn-store.js';
import { ArenaTurnsController } from './agent/turns.controller.js';
import {
  ArenaArtifactsController,
  PrivateArtifactsController,
} from './artifacts/artifacts.controller.js';
import { ArenasController } from './arenas/arenas.controller.js';
import { BridgeController } from './bridge/bridge.controller.js';
import { BearerTokens } from './ext/bearer.js';
import { DeviceController } from './ext/device.controller.js';
import { CodingController, PullsController } from './code/code.controller.js';
import { LlmController } from './llm/llm.controller.js';
import type { ModelTier } from './llm/models.js';
import { LlmProxy } from './llm/proxy.js';
import { ArenaFilesController, PrivateFilesController } from './files/files.controller.js';
import type { GithubAppConfig } from './github/github-app.js';
import { ArenaGithubController, GithubAppController } from './github/github.controller.js';
import { GithubService } from './github/github.js';
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
import { ExtensionsController } from './extensions/extensions.controller.js';
import {
  AiProvidersController,
  ArenaAiKeyController,
  MyAiKeyController,
} from './ai-keys/ai-keys.controller.js';
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
  BEARER_TOKENS,
  CLOCK,
  LLM_PROXY,
  type Clock,
  DATABASE,
  GITHUB,
  INVITE_KEY,
  CONNECTION_KEY,
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
  /** Domain attribute of `parallelflow_csrf` (COOKIE_DOMAIN). */
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
  /**
   * The nightly memory (ADR-045): every 15 minutes, arenas whose day has ended get their chapter
   * and STATE.md. Off by default (tests); main.ts turns it on. Single instance only.
   */
  memorySchedule?: boolean;
  /** Outgoing email (SMTP_URL). Unset = no emails; links are copied by hand. */
  mailer?: Mailer;
  /**
   * The extension's LLM proxy (ADR-037): OPENROUTER_API_KEY and the allowed models (primary first).
   * Unset key = /llm/chat/completions answers 503.
   */
  llm?: {
    apiKey?: string;
    apiKeys?: string[];
    models: string[];
    tiers?: Record<string, ModelTier>;
  };
  /**
   * The ParallelFlow GitHub App (ADR-040): GITHUB_APP_* and GITHUB_WEBHOOK_SECRET. Unset = arenas
   * cannot connect to GitHub and the Overview says so.
   */
  github?: GithubAppConfig;
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
/** LLM proxy requests (OpenAI chat completions with long contexts). */
const LLM_BODY_LIMIT = '4mb';
/** A coding session's pushed git bundle. */
const BUNDLE_BODY_LIMIT = '50mb';
/** GitHub webhook payloads (GitHub caps them at 25 MB; push payloads are far smaller). */
const WEBHOOK_BODY_LIMIT = '25mb';

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
  connections: Buffer,
): AgentTurns {
  const broadcaster = new TurnBroadcaster();
  const runner = new TurnRunner({
    store: new DbTurnStore(options.db, cache, connections),
    client: options.runtime?.client,
    mintToolToken: options.runtime?.mintToolToken,
    broadcaster,
    logger,
  });
  return { runner, broadcaster, limiter: new AiTurnLimiter(30, 60_000, clock) };
}

/**
 * AES-256-GCM key for connected services' credentials (ADR-039), derived from the cookie password.
 * Without one (tests, no auth) a random key: sealed credentials do not survive a restart.
 */
function connectionKey(options: ApiOptions): Buffer {
  const secret = options.auth?.cookiePassword;
  if (!secret) return randomBytes(32);
  return Buffer.from(
    hkdfSync('sha256', secret, 'parallelflow.connections.v1', 'connections enc', 32),
  );
}

/** HMAC key of the GitHub connect `state` and repo grants, derived from the cookie password. */
function githubStateKey(options: ApiOptions): Buffer {
  const secret = options.auth?.cookiePassword;
  if (!secret) return randomBytes(32);
  return Buffer.from(hkdfSync('sha256', secret, 'parallelflow.github.v1', 'github state', 32));
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
  const connections = connectionKey(options);
  const turns = agentTurns(options, logger, clock, cache, connections);
  const repos = new ArenaRepos(
    options.repoDir ?? mkdtempSync(join(tmpdir(), 'parallelflow-repos-')),
    logger,
  );
  // STATE.md, the arena's memory (ADR-045): told each night from its knowledge graph.
  const memory = new MemoryJobs({
    db: options.db,
    runner: turns.runner,
    repos,
    logger,
    cache,
    clock,
  });
  if (options.memorySchedule) memory.start();
  // PROGRESS.md, the activity log (ADR-044): every recorded event schedules its arena's render.
  const activity = new ActivityJobs({ db: options.db, repos, logger, cache, clock });
  setArenaEventListener((scope) => activity.touch(scope));
  const github = new GithubService({
    db: options.db,
    repos,
    logger,
    clock,
    webOrigin: options.webOrigin ?? DEFAULT_WEB_ORIGIN,
    stateKey: githubStateKey(options),
    ...(options.github && { config: options.github }),
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
      ExtensionsController,
      AiProvidersController,
      MyAiKeyController,
      ArenaAiKeyController,
      BridgeController,
      PrivateArtifactsController,
      ArenaArtifactsController,
      PrivateFilesController,
      ArenaFilesController,
      DeviceController,
      LlmController,
      CodingController,
      PullsController,
      ArenaGithubController,
      GithubAppController,
      ...(session ? [AuthController] : []),
      ...(options.controllers ?? []),
    ],
    providers: [
      { provide: DATABASE, useValue: options.db },
      { provide: SESSION_VERIFIER, useValue: verifier },
      ...(session ? [{ provide: WEB_SESSION, useValue: session }] : []),
      { provide: LOGGER, useValue: logger },
      { provide: AGENT_TURNS, useValue: turns },
      { provide: MEMORY_JOBS, useValue: memory },
      { provide: ACTIVITY_JOBS, useValue: activity },
      { provide: READ_CACHE, useValue: cache },
      { provide: RATE_LIMITS, useValue: { ...DEFAULT_RATE_LIMITS, ...options.rateLimits } },
      { provide: CLOCK, useValue: clock },
      { provide: WEB_ORIGIN, useValue: options.webOrigin ?? DEFAULT_WEB_ORIGIN },
      { provide: INVITE_KEY, useValue: inviteKey(options) },
      { provide: CONNECTION_KEY, useValue: connections },
      { provide: MAILER, useValue: options.mailer ?? null },
      { provide: ARENA_REPOS, useValue: repos },
      { provide: GITHUB, useValue: github },
      { provide: BEARER_TOKENS, useValue: new BearerTokens(options.db, clock) },
      {
        provide: LLM_PROXY,
        useValue: new LlmProxy({
          ...(options.llm?.apiKey && { apiKey: options.llm.apiKey }),
          ...(options.llm?.apiKeys?.length && { apiKeys: options.llm.apiKeys }),
          models: options.llm?.models ?? [],
          ...(options.llm?.tiers && { tiers: options.llm.tiers }),
          logger,
          referer: options.webOrigin ?? DEFAULT_WEB_ORIGIN,
        }),
      },
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
  // Route-specific limits first: a parsed body is skipped by the global parsers below.
  app.use('/v1/llm', json({ limit: LLM_BODY_LIMIT }));
  app.use(
    '/v1/ext/projects/:projectId/coding-sessions/:sessionId/push',
    raw({ limit: BUNDLE_BODY_LIMIT, type: 'application/octet-stream' }),
  );
  // The webhook's signature covers the exact bytes, so its body stays raw (a Buffer).
  app.use('/v1/github/webhook', raw({ limit: WEBHOOK_BODY_LIMIT, type: () => true }));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useBodyParser('raw', { limit: UPLOAD_BODY_LIMIT, type: 'application/octet-stream' });
  app.setGlobalPrefix('v1');
  await app.init();
  return app;
}
