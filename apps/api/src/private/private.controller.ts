import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  type AnswerQuestion,
  AnswerQuestionSchema,
  answerTurnText,
  type ArenaTurnStreamEvent,
  type ChatMessagePage,
  type CreatePrivateChat,
  CreatePrivateChatSchema,
  type ListArenaMessagesQuery,
  ListArenaMessagesQuerySchema,
  type ListPrivateChatsQuery,
  ListPrivateChatsQuerySchema,
  type MovePrivateChat,
  MovePrivateChatSchema,
  type PrivateChat,
  type PrivateChatList,
  type PrivateMessage,
  type PrivateProject,
  type PrivateProjectList,
  type PrivateProjectName,
  PrivateProjectNameSchema,
  type RenamePrivateChat,
  RenamePrivateChatSchema,
  type SendArenaMessage,
  SendArenaMessageSchema,
  type SendMessageResult,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import type { Request, Response } from 'express';
import { AGENT_TURNS, type AgentTurns } from '../agent/agent-turns.js';
import {
  AfterCommit,
  type AfterCommitFn,
  Caller,
  DbTx,
  Idempotent,
} from '../pipeline/decorators.js';
import { CachedRead } from '../pipeline/read-cache.js';
import { notFound, validationFailed } from '../pipeline/errors.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import {
  answerPrivateQuestion,
  createChat,
  createProject,
  deleteChat,
  deleteProject,
  getChat,
  listChats,
  listPrivateMessages,
  listProjects,
  moveChat,
  postPrivateMessage,
  renameChat,
  renameProject,
} from './chats.js';
import { queuePrivateTurn } from './private-turns.js';

// Private chats and projects (build step 5, ADR-034; openapi_v2.yaml Private tag). Unscoped routes:
// the pipeline opens a user-scope transaction (db.withUser), so RLS shows the caller's own Private
// rows only. Unknown ids and other people's ids are both 404. Mutations need CSRF (AuthGuard);
// creating POSTs need an Idempotency-Key.
//   GET    /private/sessions?q=                   your chats, newest activity first
//   POST   /private/sessions                      new chat
//   GET    /private/sessions/:id                  one chat
//   PATCH  /private/sessions/:id                  rename
//   DELETE /private/sessions/:id                  delete (messages and AI turns too)
//   PUT    /private/sessions/:id/project          file in a project, or null for Recent
//   GET    /private/sessions/:id/messages         latest page; ?after= polls; ?cursor= older page
//   POST   /private/sessions/:id/messages         your message; starts an AI turn (30/min/user)
//   POST   /private/sessions/:id/messages/:messageId/answer   answer the AI's question; starts its turn
//   GET    /private/sessions/:id/turns/:turnId/events   AI live text (SSE), like the arena's
//   GET    /private/projects                      your projects with chat counts
//   POST   /private/projects                      new project
//   PATCH  /private/projects/:id                  rename
//   DELETE /private/projects/:id                  delete; its chats move to Recent

const HEARTBEAT_MS = 15_000;

/** A path id, lower-cased; anything that is not a uuid is 404 (never reveals what exists). */
function pathId(value: string): string {
  if (!isUuid(value)) throw notFound();
  return value.toLowerCase();
}

/** The private message query is the arena's, without threads. */
function noThreads(query: ListArenaMessagesQuery): ListArenaMessagesQuery {
  if (query.parent_id) {
    throw validationFailed([{ field: 'parent_id', message: 'Private chats have no threads' }]);
  }
  return query;
}

@Controller('private')
export class PrivateController {
  constructor(@Inject(AGENT_TURNS) private readonly turns: AgentTurns) {}

  @CachedRead()
  @Get('sessions')
  @Header('Cache-Control', 'no-store')
  async list(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Query(new ZodPipe(ListPrivateChatsQuerySchema)) query: ListPrivateChatsQuery,
  ): Promise<PrivateChatList> {
    return { items: await listChats(tx, caller.userId, query), next_cursor: null };
  }

  @Post('sessions')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async create(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(CreatePrivateChatSchema)) body: CreatePrivateChat,
  ): Promise<PrivateChat> {
    return createChat(tx, caller.userId, body);
  }

  @CachedRead()
  @Get('sessions/:id')
  @Header('Cache-Control', 'no-store')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
  ): Promise<PrivateChat> {
    return getChat(tx, caller.userId, pathId(id));
  }

  @Patch('sessions/:id')
  @Header('Cache-Control', 'no-store')
  async rename(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(RenamePrivateChatSchema)) body: RenamePrivateChat,
  ): Promise<PrivateChat> {
    return renameChat(tx, caller.userId, pathId(id), body.title);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async remove(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
  ): Promise<void> {
    await deleteChat(tx, caller.userId, pathId(id));
  }

  @Put('sessions/:id/project')
  @Header('Cache-Control', 'no-store')
  async move(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(MovePrivateChatSchema)) body: MovePrivateChat,
  ): Promise<PrivateChat> {
    return moveChat(tx, caller.userId, pathId(id), body.private_project_id);
  }

  @CachedRead()
  @Get('sessions/:id/messages')
  @Header('Cache-Control', 'no-store')
  async messages(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Query(new ZodPipe(ListArenaMessagesQuerySchema)) query: ListArenaMessagesQuery,
  ): Promise<ChatMessagePage<PrivateMessage>> {
    return listPrivateMessages(tx, caller.userId, pathId(id), noThreads(query));
  }

  @Post('sessions/:id/messages')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async post(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('id') id: string,
    @Body(new ZodPipe(SendArenaMessageSchema)) body: SendArenaMessage,
  ): Promise<SendMessageResult<PrivateMessage>> {
    if (body.parent_id) {
      throw validationFailed([{ field: 'parent_id', message: 'Private chats have no threads' }]);
    }
    const sessionId = pathId(id);
    const message = await postPrivateMessage(
      tx,
      caller.userId,
      sessionId,
      body.body,
      body.attachments,
    );
    const ai = await queuePrivateTurn(
      tx,
      { userId: caller.userId, sessionId },
      message,
      this.turns.limiter,
    );
    const { job } = ai;
    if (job) afterCommit(() => this.turns.runner.start(job));
    return { message, turn: ai.turn, ...(ai.skipped && { ai_skipped: ai.skipped }) };
  }

  @Post('sessions/:id/messages/:messageId/answer')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async answer(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body(new ZodPipe(AnswerQuestionSchema)) body: AnswerQuestion,
  ): Promise<SendMessageResult<PrivateMessage>> {
    const sessionId = pathId(id);
    const { message, question } = await answerPrivateQuestion(
      tx,
      caller.userId,
      sessionId,
      pathId(messageId),
      body.choice,
    );
    const ai = await queuePrivateTurn(
      tx,
      { userId: caller.userId, sessionId },
      message,
      this.turns.limiter,
      answerTurnText(question.question, question.answer?.choice ?? body.choice),
    );
    const { job } = ai;
    if (job) afterCommit(() => this.turns.runner.start(job));
    return { message, turn: ai.turn, ...(ai.skipped && { ai_skipped: ai.skipped }) };
  }

  /** AI live text as Server-Sent Events, ending with one `status` event (as for the arena). */
  @Get('sessions/:id/turns/:turnId/events')
  async events(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Param('turnId') turnId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const sessionId = pathId(id);
    const turnKey = pathId(turnId);
    await getChat(tx, caller.userId, sessionId);
    const turn = await tx
      .selectFrom('runtime_turns as t')
      .innerJoin('agent_sessions as s', 's.id', 't.agent_session_id')
      .select(['t.status', 't.failure_code'])
      .where('t.id', '=', turnKey)
      .where('s.private_session_id', '=', sessionId)
      .executeTakeFirst();
    if (!turn) throw notFound();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let open = true;
    const send = (event: ArenaTurnStreamEvent) => {
      if (!open) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'status') close();
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const subscription: { off?: () => void } = {};
    const close = () => {
      if (!open) return;
      open = false;
      clearInterval(heartbeat);
      subscription.off?.();
      res.end();
    };
    req.on('close', close);

    subscription.off = this.turns.broadcaster.subscribe(turnKey, send);
    if (!subscription.off) {
      send({
        type: 'status',
        status: turn.status,
        failure_code: turn.failure_code,
        message_id: null,
      });
    }
  }

  @CachedRead()
  @Get('projects')
  @Header('Cache-Control', 'no-store')
  async projects(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<PrivateProjectList> {
    return { items: await listProjects(tx, caller.userId) };
  }

  @Post('projects')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async createProject(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(PrivateProjectNameSchema)) body: PrivateProjectName,
  ): Promise<PrivateProject> {
    return createProject(tx, caller.userId, body.name);
  }

  @Patch('projects/:id')
  @Header('Cache-Control', 'no-store')
  async renameProject(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(PrivateProjectNameSchema)) body: PrivateProjectName,
  ): Promise<PrivateProject> {
    return renameProject(tx, caller.userId, pathId(id), body.name);
  }

  @Delete('projects/:id')
  @HttpCode(204)
  async deleteProject(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
  ): Promise<void> {
    await deleteProject(tx, caller.userId, pathId(id));
  }
}
