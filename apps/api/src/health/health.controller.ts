import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Database } from '@parallelflow/db';
import type { Response } from 'express';
import { Public } from '../pipeline/auth.js';
import { DATABASE } from '../pipeline/tokens.js';

export interface HealthBody {
  status: 'ok' | 'unavailable';
  database: 'ok' | 'unreachable';
}

/**
 * Liveness and database reachability for the load balancer and the runbooks (doc 11 §11.9).
 * Operational, not part of openapi_v2.yaml. Public, reads no data, reveals no configuration.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Public()
  @Get()
  async health(@Res({ passthrough: true }) res: Response): Promise<HealthBody> {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await this.db.ping();
      return { status: 'ok', database: 'ok' };
    } catch {
      res.status(503);
      return { status: 'unavailable', database: 'unreachable' };
    }
  }
}
