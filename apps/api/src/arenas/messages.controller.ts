import { Body, Controller, Get, Header, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  type ArenaMessagePage,
  type ListArenaMessagesQuery,
  ListArenaMessagesQuerySchema,
  type ProjectMemberList,
  type SendArenaMessage,
  type SendArenaMessageResult,
  SendArenaMessageSchema,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import { Caller, DbTx, Idempotent, ProjectScoped } from '../pipeline/decorators.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import {
  ARENA_POST,
  hasCapability,
  listArenaMessages,
  listProjectMembers,
  postArenaMessage,
} from './messages.js';

// Arena chat (build step 3; openapi_v2.yaml listArenaMessages, postArenaMessage, listProjectMembers).
// `projectId` is the arena's project id, the same id the web uses for /arena/{id}. The pipeline has
// already verified an active membership (non-member 404, inactive 403) and opened the tenant tx.
//   GET  /projects/:projectId/arena/messages   latest page; ?after= polls; ?cursor= older page
//   POST /projects/:projectId/arena/messages   CSRF + Idempotency-Key; needs cap arena.post
//   GET  /projects/:projectId/members          members, roles, and whether you can post

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class ArenaChatController {
  @Get('arena/messages')
  @Header('Cache-Control', 'no-store')
  async list(
    @DbTx() tx: Tx,
    @Param('projectId') projectId: string,
    @Query(new ZodPipe(ListArenaMessagesQuerySchema)) query: ListArenaMessagesQuery,
  ): Promise<ArenaMessagePage> {
    return listArenaMessages(tx, projectId.toLowerCase(), query);
  }

  @Post('arena/messages')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async post(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(SendArenaMessageSchema)) body: SendArenaMessage,
  ): Promise<SendArenaMessageResult> {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    const message = await postArenaMessage(
      tx,
      { projectId: projectId.toLowerCase(), orgId: caller.orgId, userId: caller.userId },
      body,
    );
    return { message };
  }

  @Get('members')
  @Header('Cache-Control', 'no-store')
  async members(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<ProjectMemberList> {
    const id = projectId.toLowerCase();
    // One transaction, one connection: the two reads run one after the other.
    const items = await listProjectMembers(tx, id);
    const canPost = await hasCapability(tx, id, caller.userId, ARENA_POST);
    return { items, viewer: { user_id: caller.userId, can_post: canPost } };
  }
}
