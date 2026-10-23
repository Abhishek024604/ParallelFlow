import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { ArenaTurnStreamEvent } from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import type { Request, Response } from 'express';
import { DbTx, ProjectScoped } from '../pipeline/decorators.js';
import { notFound } from '../pipeline/errors.js';
import { isUuid } from '../pipeline/request-context.js';
import { AGENT_TURNS, type AgentTurns } from './agent-turns.js';

// GET /projects/:projectId/arena/turns/:turnId/events: live text of an AI turn as Server-Sent Events
// (`data: <ArenaTurnStreamEvent JSON>`), ending with one `status` event. The pipeline has verified an
// active membership; the turn must belong to this project's arena (else 404). The membership check and
// the turn lookup happen in the handler's transaction, which commits when the handler returns: the
// stream itself holds no database connection. Clients that miss the stream get the AI's message from
// polling. Text is never logged.

const HEARTBEAT_MS = 15_000;

@Controller('projects/:projectId')
@ProjectScoped('projectId')
export class ArenaTurnsController {
  constructor(@Inject(AGENT_TURNS) private readonly turns: AgentTurns) {}

  @Get('arena/turns/:turnId/events')
  async events(
    @DbTx() tx: Tx,
    @Param('projectId') projectId: string,
    @Param('turnId') turnId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!isUuid(turnId)) throw notFound();
    const id = turnId.toLowerCase();
    const turn = await tx
      .selectFrom('runtime_turns as t')
      .innerJoin('agent_sessions as s', 's.id', 't.agent_session_id')
      .innerJoin('arenas as a', 'a.id', 's.arena_id')
      .select(['t.status', 't.failure_code'])
      .where('t.id', '=', id)
      .where('a.project_id', '=', projectId.toLowerCase())
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

    subscription.off = this.turns.broadcaster.subscribe(id, send);
    if (!subscription.off) {
      // Not running on this instance (finished long ago, or another instance): the stored status.
      send({
        type: 'status',
        status: turn.status,
        failure_code: turn.failure_code,
        message_id: null,
      });
    }
  }
}
