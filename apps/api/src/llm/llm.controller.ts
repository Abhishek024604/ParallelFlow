import { Body, Controller, Get, Header, Inject, Post, Res } from '@nestjs/common';
import type { Tx } from '@saras/db';
import type { Response } from 'express';
import { BearerOnly } from '../pipeline/auth.js';
import { AfterCommit, type AfterCommitFn, Caller, DbTx } from '../pipeline/decorators.js';
import { RateLimiter } from '../pipeline/rate-limit.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { LLM_PROXY } from '../pipeline/tokens.js';
import type { LlmProxy } from './proxy.js';

// The LLM proxy (ADR-037). Bearer only: the VS Code extension's token, never the web session.
//   GET  /llm/models             the allowed models (OpenAI list shape)
//   POST /llm/chat/completions   OpenAI-compatible; `stream: true` relays the SSE stream
// The request is counted in the caller's `llm` bucket (60 / min) inside the pipeline's transaction;
// once that commits, the call is forwarded (AfterCommit), so no database connection is held while
// the model answers. Bodies are at most 4 MB (app.ts) and never logged.

@Controller('llm')
@BearerOnly()
export class LlmController {
  constructor(
    @Inject(LLM_PROXY) private readonly proxy: LlmProxy,
    @Inject(RateLimiter) private readonly limiter: RateLimiter,
  ) {}

  @Get('models')
  @Header('Cache-Control', 'no-store')
  models() {
    return this.proxy.models();
  }

  @Post('chat/completions')
  async chat(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body() body: unknown,
    @Res() res: Response,
    @AfterCommit() afterCommit: AfterCommitFn,
  ): Promise<void> {
    const problem = this.proxy.check(body);
    if (problem) {
      res.status(problem.status).json(problem.body);
      return;
    }
    this.limiter.apply(res, [await this.limiter.hit(tx, 'llm', caller.userId)]);
    afterCommit(() => void this.proxy.forward(body, res));
  }
}
