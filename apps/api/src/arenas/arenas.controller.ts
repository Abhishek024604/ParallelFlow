import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import {
  type ArenaDetail,
  type ArenaList,
  type CreateArena,
  type CreateArenaResponse,
  CreateArenaSchema,
} from '@parallelflow/contracts';
import type { Database, Tx } from '@parallelflow/db';
import { BearerAllowed } from '../pipeline/auth.js';
import { Caller, DbTx, Idempotent, ProjectScoped } from '../pipeline/decorators.js';
import { CachedRead } from '../pipeline/read-cache.js';
import { ApiError, notFound } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { DATABASE, INVITE_KEY, WEB_ORIGIN } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import { arenaDetail, listArenas } from './arenas.js';
import { createArena } from './create-arena.js';

// /v1/arenas (openapi_v2.yaml createArena, listArenas, getArenaSummary; ADR-029).
//   POST  authenticated + CSRF + Idempotency-Key. Creates the hidden org and the whole arena in one
//         transaction (create-arena.ts) and returns the invite links once. The idempotency record
//         stores the response without the links, so a replay never reveals a secret it stored.
//   GET   your arenas (user scope, then one verified tenant read per arena).
//   GET /:arenaId  one arena you belong to (verified project membership; 404 otherwise).

/** A replayed create shows the invites without their links (they are never stored). */
function withoutLinks(body: unknown): unknown {
  const response = body as CreateArenaResponse;
  return { ...response, invites: response.invites.map((i) => ({ ...i, link: null })) };
}

@Controller('arenas')
export class ArenasController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(INVITE_KEY) private readonly inviteKey: Buffer,
  ) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent({ storeBody: withoutLinks })
  async create(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(CreateArenaSchema)) body: CreateArena,
  ): Promise<CreateArenaResponse> {
    const me = await tx
      .selectFrom('users')
      .select(['email'])
      .where('id', '=', caller.userId)
      .where('deactivated_at', 'is', null)
      .executeTakeFirst();
    if (!me) throw new ApiError(401, 'UNAUTHENTICATED');
    return createArena(this.db, { userId: caller.userId, email: me.email }, body, {
      webOrigin: this.webOrigin,
      inviteKey: this.inviteKey,
    });
  }

  @BearerAllowed()
  @CachedRead()
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<ArenaList> {
    return { items: await listArenas(this.db, tx, caller.userId) };
  }

  @BearerAllowed()
  @CachedRead()
  @Get(':arenaId')
  @Header('Cache-Control', 'no-store')
  @ProjectScoped('arenaId')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    // Already checked by the pipeline: a uuid of a project you are an active member of.
    @Param('arenaId') arenaId: string,
  ): Promise<ArenaDetail> {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    const detail = await arenaDetail(tx, arenaId.toLowerCase(), caller.userId, {
      key: this.inviteKey,
      orgId: caller.orgId,
    });
    if (!detail) throw notFound();
    return detail;
  }
}
