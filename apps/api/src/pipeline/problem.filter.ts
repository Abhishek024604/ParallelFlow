import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import { PROBLEM_CONTENT_TYPE } from '@saras/contracts';
import type { Request, Response } from 'express';
import { toProblem } from './errors.js';
import { findState } from './request-context.js';
import { REQUEST_ID_HEADER, uuidv7 } from './request-id.js';

/** Step 9 (doc 05 §5.5): everything thrown becomes application/problem+json. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(err: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const state = findState(req);
    const requestId = state?.requestId ?? uuidv7();
    const { status, problem, headers, internal } = toProblem(err, requestId);

    if (state) {
      state.code = problem.code;
      if (internal) {
        state.errName = internal.name;
        if (internal.code) state.errCode = internal.code;
      }
    }
    if (res.headersSent) {
      res.end();
      return;
    }
    res.setHeader(REQUEST_ID_HEADER, requestId);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    res.status(status).type(PROBLEM_CONTENT_TYPE).send(JSON.stringify(problem));
  }
}
