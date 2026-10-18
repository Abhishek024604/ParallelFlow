import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  type AnswerQuestion,
  AnswerQuestionSchema,
  answerTurnText,
  type ArenaMessage,
  type ArenaMessagePage,
  type ListArenaMessagesQuery,
  ListArenaMessagesQuerySchema,
  type ProjectMemberList,
  type SendArenaMessage,
  type SendArenaMessageResult,
  SendArenaMessageSchema,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import { AGENT_TURNS, type AgentTurns, queueAiTurn } from '../agent/agent-turns.js';
import { PROGRESS_JOBS, type ProgressJobs } from '../progress/progress-jobs.js';
import { progressDue } from '../progress/progress-store.js';
import {
  AfterCommit,
  type AfterCommitFn,
  Caller,
  DbTx,
  Idempotent,
  ProjectScoped,
} from '../pipeline/decorators.js';
import { CachedRead } from '../pipeline/read-cache.js';
import { notFound } from '../pipeline/errors.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import {
  answerArenaQuestion,
  ARENA_POST,
  getArenaMessage,
  hasCapability,
  listArenaMessages,
  listProjectMembers,
  postArenaMessage,
} from './messages.js';

// Arena chat (build step 3; openapi_v2.yaml listArenaMessages, postArenaMessage, listProjectMembers).
// `projectId` is the arena's project id, the same id the web uses for /arena/{id}. The pipeline has
// already verified an active membership (non-member 404, inactive 403) and opened the tenant tx.
//   GET  /projects/:projectId/arena/messages   latest page; ?after= polls; ?cursor= older page
//   POST /projects/:projectId/arena/messages   CSRF + Idempotency-Key; needs cap arena.post. "@AI"
//                                              also queues an AI turn (cap agent.invoke, 30/min/user)
//   GET  /projects/:projectId/arena/messages/:messageId   one message (a thread's root)
//   POST /projects/:projectId/arena/messages/:messageId/answer   the asker answers the AI's question;
//                                              posts their answer and starts the AI's next turn
//   GET  /projects/:projectId/members          members, roles, and whether you can post

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class ArenaChatController {
  constructor(
    @Inject(AGENT_TURNS) private readonly turns: AgentTurns,
    @Inject(PROGRESS_JOBS) private readonly progress: ProgressJobs,
  ) {}

  @CachedRead()
  @Get('arena/messages')
  @Header('Cache-Control', 'no-store')
  async list(
    @DbTx() tx: Tx,
    @Param('projectId') projectId: string,
    @Query(new ZodPipe(ListArenaMessagesQuerySchema)) query: ListArenaMessagesQuery,
  ): Promise<ArenaMessagePage> {
    return listArenaMessages(tx, projectId.toLowerCase(), query);
  }

  @CachedRead()
  @Get('arena/messages/:messageId')
  @Header('Cache-Control', 'no-store')
  async one(
    @DbTx() tx: Tx,
    @Param('projectId') projectId: string,
    @Param('messageId') messageId: string,
  ): Promise<ArenaMessage> {
    if (!isUuid(messageId)) throw notFound();
    return getArenaMessage(tx, projectId.toLowerCase(), messageId.toLowerCase());
  }

  @Post('arena/messages')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async post(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(SendArenaMessageSchema)) body: SendArenaMessage,
  ): Promise<SendArenaMessageResult> {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    const ctx = { projectId: projectId.toLowerCase(), orgId: caller.orgId, userId: caller.userId };
    const message = await postArenaMessage(tx, ctx, body);
    const ai = await queueAiTurn(tx, ctx, message, this.turns.limiter);
    const { job } = ai;
    if (job) afterCommit(() => this.turns.runner.start(job));
    // About every 20 human messages, the progress log gets an entry (progress/).
    if (await progressDue(tx, ctx.projectId, message.arena_id)) {
      afterCommit(() => this.progress.request({ ...ctx, trigger: 'messages' }));
    }
    return { message, turn: ai.turn, ...(ai.skipped && { ai_skipped: ai.skipped }) };
  }

  @Post('arena/messages/:messageId/answer')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async answer(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @AfterCommit() afterCommit: AfterCommitFn,
    @Param('projectId') projectId: string,
    @Param('messageId') messageId: string,
    @Body(new ZodPipe(AnswerQuestionSchema)) body: AnswerQuestion,
  ): Promise<SendArenaMessageResult> {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    if (!isUuid(messageId)) throw notFound();
    const ctx = { projectId: projectId.toLowerCase(), orgId: caller.orgId, userId: caller.userId };
    const { message, question } = await answerArenaQuestion(
      tx,
      ctx,
      messageId.toLowerCase(),
      body.choice,
    );
    const ai = await queueAiTurn(tx, ctx, message, this.turns.limiter, {
      force: true,
      text: answerTurnText(question.question, question.answer?.choice ?? body.choice),
    });
    const { job } = ai;
    if (job) afterCommit(() => this.turns.runner.start(job));
    return { message, turn: ai.turn, ...(ai.skipped && { ai_skipped: ai.skipped }) };
  }

  @CachedRead()
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
