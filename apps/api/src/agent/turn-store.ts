import type { Database, Tx } from '@saras/db';
import type { SdlcStage } from '@saras/runtime-client';
import { sql } from 'kysely';
import { insertAgentMessage, listProjectMembers } from '../arenas/messages.js';
import { PrivateTurnStore } from '../private/private-turns.js';
import type { ArenaTurnJob, TurnContext, TurnJob, TurnOutcome, TurnStore } from './turn-runner.js';

// Background writes of an AI turn. They run after the request that queued the turn has returned, so
// there is no request membership to verify: each write opens withSystemJob for the turn's own org
// (allowlisted in eslint.config.js, build step 4). Every query is also filtered by the turn's ids, so
// one arena's turn never reads or writes another arena's rows. Message text is never logged.
// Private turns (ADR-034) have no org: PrivateTurnStore writes them in user scope as the owner.

export class DbTurnStore implements TurnStore {
  private readonly privateStore: PrivateTurnStore;

  constructor(private readonly db: Database) {
    this.privateStore = new PrivateTurnStore(db);
  }

  private job<T>(job: ArenaTurnJob, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withSystemJob({ orgId: job.orgId }, fn);
  }

  begin(job: TurnJob): Promise<TurnContext> {
    if (job.kind === 'private') return this.privateStore.begin(job);
    return this.job(job, async (tx) => {
      const turn = await tx
        .updateTable('runtime_turns')
        .set({ status: 'running' })
        .where('id', '=', job.turnId)
        .where('status', '=', 'queued')
        .returning('agent_session_id')
        .executeTakeFirst();
      if (!turn) throw new Error('Turn is not queued');

      const session = await tx
        .selectFrom('agent_sessions as s')
        .innerJoin('agents as a', 'a.id', 's.agent_id')
        .select(['s.id', 's.session_key', 's.runtime_session_id', 'a.id as agent_id', 'a.name'])
        .where('s.id', '=', turn.agent_session_id)
        .where('s.arena_id', '=', job.arenaId)
        .executeTakeFirstOrThrow();
      const project = await tx
        .selectFrom('projects')
        .select(['name', 'description'])
        .where('id', '=', job.projectId)
        .executeTakeFirstOrThrow();
      const members = (await listProjectMembers(tx, job.projectId)).map((m) => ({
        user_id: m.user_id,
        display_name: m.display_name,
        roles: m.roles.map((r) => r.name),
      }));
      const policies = await tx
        .selectFrom('agent_policies')
        .select(['class', 'autonomy'])
        .where('project_id', '=', job.projectId)
        .execute();
      const cycle = await tx
        .selectFrom('sdlc_cycles')
        .select(['number', 'stage'])
        .where('project_id', '=', job.projectId)
        .where('status', 'in', ['active', 'operating'])
        .orderBy('number', 'desc')
        .executeTakeFirst();

      const author = members.find((m) => m.user_id === job.userId);
      return {
        agentSessionId: session.id,
        sessionKey: session.session_key,
        runtimeSessionId: session.runtime_session_id,
        agent: { id: session.agent_id, name: session.name },
        project,
        members,
        author: { display_name: author?.display_name ?? 'Teammate', roles: author?.roles ?? [] },
        autonomy: Object.fromEntries(policies.map((p) => [p.class, p.autonomy])),
        cycle: cycle ? { number: cycle.number, stage: cycle.stage as SdlcStage } : null,
      };
    });
  }

  async saveRuntimeSession(
    job: TurnJob,
    agentSessionId: string,
    runtimeSessionId: string,
  ): Promise<void> {
    if (job.kind === 'private') {
      await this.privateStore.saveRuntimeSession(job, agentSessionId, runtimeSessionId);
      return;
    }
    await this.job(job, (tx) =>
      tx
        .updateTable('agent_sessions')
        .set({ runtime_session_id: runtimeSessionId, status: 'ready' })
        .where('id', '=', agentSessionId)
        .where('arena_id', '=', job.arenaId)
        .execute(),
    );
  }

  insertAgentMessage(job: TurnJob, agentId: string, text: string): Promise<string> {
    if (job.kind === 'private') return this.privateStore.insertAgentMessage(job, agentId, text);
    return this.job(job, (tx) =>
      insertAgentMessage(tx, {
        orgId: job.orgId,
        arenaId: job.arenaId,
        agentId,
        turnId: job.turnId,
        body: text,
      }),
    );
  }

  async finish(job: TurnJob, outcome: TurnOutcome): Promise<void> {
    if (job.kind === 'private') {
      await this.privateStore.finish(job, outcome);
      return;
    }
    await this.job(job, async (tx) => {
      await tx
        .updateTable('runtime_turns')
        .set({
          status: outcome.status,
          failure_code: outcome.failureCode,
          usage: JSON.stringify(outcome.usage ?? {}),
          finished_at: sql<Date>`now()`,
        })
        .where('id', '=', job.turnId)
        .execute();
      await sql`UPDATE agent_sessions SET last_turn_at = now()
                 WHERE id = (SELECT agent_session_id FROM runtime_turns WHERE id = ${job.turnId})`.execute(
        tx,
      );
    });
  }
}
