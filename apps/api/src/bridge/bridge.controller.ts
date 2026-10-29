import { Body, Controller, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  type BindRequest,
  BindRequestSchema,
  type ChatFromArena,
  ChatFromArenaSchema,
  type CopyFromArena,
  CopyFromArenaSchema,
  type CopyFromArenaResult,
  type PrivateChat,
  type PrivateMessage,
  type PullContext,
  PullContextSchema,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import { Caller, DbTx, Idempotent } from '../pipeline/decorators.js';
import { notFound } from '../pipeline/errors.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import { getChat } from '../private/chats.js';
import { bindChat, chatFromArena, copyFromArena, pullContext } from './bridge.js';

// The bridge's chat routes (openapi_v2.yaml bindPrivateSession, pullContext). Unscoped: the
// pipeline opens your user scope; bridge.ts enters the arena's verified tenant context itself.
// CSRF (AuthGuard) and an Idempotency-Key on both. Push lives on /artifacts/{id}/push.
//   POST /private/sessions/:id:bind                  link to one arena (write-once; owner + arena.read)
//   POST /private/sessions/:id/bridge/pull-context   bring context (links first when `project_id`)
//   POST /private/sessions/:id/bridge/copy-from-arena copy arena files in (ADR-041; links if unlinked)
//   POST /private/sessions/from-arena                 a new linked chat with arena files (or a handoff)

function pathId(value: string): string {
  if (!isUuid(value)) throw notFound();
  return value.toLowerCase();
}

@Controller('private/sessions')
export class BridgeController {
  @Post(':id\\:bind')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async bind(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(BindRequestSchema)) body: BindRequest,
  ): Promise<PrivateChat> {
    const sessionId = pathId(id);
    await bindChat(tx, caller.userId, sessionId, body.project_id);
    return getChat(tx, caller.userId, sessionId);
  }

  @Post(':id/bridge/pull-context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  pull(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(PullContextSchema)) body: PullContext,
  ): Promise<PrivateMessage> {
    return pullContext(tx, caller.userId, pathId(id), body);
  }

  @Post(':id/bridge/copy-from-arena')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  copy(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(CopyFromArenaSchema)) body: CopyFromArena,
  ): Promise<CopyFromArenaResult> {
    return copyFromArena(tx, caller.userId, pathId(id), body);
  }

  @Post('from-arena')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  fromArena(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(ChatFromArenaSchema)) body: ChatFromArena,
  ): Promise<CopyFromArenaResult> {
    return chatFromArena(tx, caller.userId, body);
  }
}
