import { Controller, Get, Header, Inject, Param } from '@nestjs/common';
import type { ArenaDetail, ArenaList } from '@saras/contracts';
import type { Database, Tx } from '@saras/db';
import { Caller, DbTx, ProjectScoped } from '../pipeline/decorators.js';
import { notFound } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { DATABASE } from '../pipeline/tokens.js';
import { arenaDetail, listArenas } from './arenas.js';

// /v1/arenas (openapi_v2.yaml listArenas, getArenaSummary; ADR-029).
//   GET   your arenas (user scope, then one verified tenant read per arena).
//   GET /:arenaId  one arena you belong to (verified project membership; 404 otherwise).

@Controller('arenas')
export class ArenasController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<ArenaList> {
    return { items: await listArenas(this.db, tx, caller.userId) };
  }

  @Get(':arenaId')
  @Header('Cache-Control', 'no-store')
  @ProjectScoped('arenaId')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    // Already checked by the pipeline: a uuid of a project you are an active member of.
    @Param('arenaId') arenaId: string,
  ): Promise<ArenaDetail> {
    const detail = await arenaDetail(tx, arenaId.toLowerCase(), caller.userId);
    if (!detail) throw notFound();
    return detail;
  }
}
