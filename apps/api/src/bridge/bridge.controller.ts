import { Body, Controller, Header, HttpCode, Param, Post } from '@nestjs/common';
import {
  type BindRequest,
  BindRequestSchema,
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
import { bindChat, pullContext } from './bridge.js';

// The bridge's chat routes (openapi_v2.yaml bindPrivateSession, pullContext). Unscoped: the
// pipeline opens your user scope; bridge.ts enters the arena's verified tenant context itself.
// CSRF (AuthGuard) and an Idempotency-Key on both. Push lives on /artifacts/{id}/push.
//   POST /private/sessions/:id:bind                  link to one arena (write-once; owner + arena.read)
//   POST /private/sessions/:id/bridge/pull-context   bring context (links first when `project_id`)

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
}
