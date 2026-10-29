import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  DEVICE_CODE_TTL_S,
  DEVICE_POLL_INTERVAL_S,
  type DeviceApprove,
  DeviceApproveSchema,
  DeviceCodeRequestSchema,
  type DeviceCodeResponse,
  type DeviceLookup,
  type DeviceTokenError,
  DeviceTokenRequestSchema,
  type ExtHandoff,
  type ExtToken,
} from '@parallelflow/contracts';
import type { Database, Tx } from '@parallelflow/db';
import type { Request, Response } from 'express';
import { BearerAllowed, Public } from '../pipeline/auth.js';
import { AfterCommit, type AfterCommitFn, Caller, DbTx } from '../pipeline/decorators.js';
import { ApiError, notFound, validationFailed } from '../pipeline/errors.js';
import { isUuid, type CallerContext } from '../pipeline/request-context.js';
import { BEARER_TOKENS, CLOCK, type Clock, DATABASE, WEB_ORIGIN } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import type { BearerTokens } from './bearer.js';
import {
  createDeviceCode,
  decideDevice,
  exchangeDeviceCode,
  formatUserCode,
  listTokens,
  lookupDevice,
  normalizeUserCode,
  revokeToken,
} from './device.js';

// Extension sign-in (ADR-037). Additive to openapi_v2.yaml (Phase A).
//   POST   /ext/device/code      public, per-IP limit   → DeviceCodeResponse
//   POST   /ext/device/token     public, per-IP limit   → 200 DeviceTokenResponse | 400 {error}
//   GET    /ext/device?user_code=  web session          → DeviceLookup (404 unknown/expired)
//   POST   /ext/device/approve   web session + CSRF     → 204 (404 unknown/expired)
//   GET    /ext/tokens           session or bearer      → { items: ExtToken[] }
//   DELETE /ext/tokens/:id       session (CSRF) or bearer → 204
// Approving a device needs the browser session: a token can never approve another device.

/** Per-IP fixed one-minute windows for the public endpoints (in memory, this instance only). */
export class IpLimiter {
  private window = { start: 0, hits: new Map<string, number>() };

  constructor(
    private readonly limit: number,
    private readonly clock: Clock,
  ) {}

  allow(ip: string): boolean {
    const now = this.clock();
    const start = Math.floor(now / 60_000) * 60_000;
    if (this.window.start !== start) this.window = { start, hits: new Map() };
    const hits = (this.window.hits.get(ip) ?? 0) + 1;
    this.window.hits.set(ip, hits);
    return hits <= this.limit;
  }
}

function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

function tokenError(res: Response, error: DeviceTokenError): void {
  res.status(400).set('Cache-Control', 'no-store').json({ error });
}

/** How a handoff shows in your list of signed-in VS Code windows. */
const HANDOFF_CLIENT = 'VS Code (opened from ParallelFlow)';

@Controller('ext')
export class DeviceController {
  private readonly codes: IpLimiter;
  private readonly polls: IpLimiter;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(BEARER_TOKENS) private readonly bearer: BearerTokens,
    @Inject(CLOCK) clock: Clock,
  ) {
    this.codes = new IpLimiter(10, clock);
    this.polls = new IpLimiter(60, clock);
  }

  @Public()
  @Post('device/code')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async code(@Req() req: Request, @Body() body: unknown): Promise<DeviceCodeResponse> {
    if (!this.codes.allow(clientIp(req))) {
      throw new ApiError(429, 'RATE_LIMITED', {
        detail: 'Too many sign-in attempts. Try again in a minute.',
        headers: { 'Retry-After': '60' },
      });
    }
    const input = new ZodPipe(DeviceCodeRequestSchema).transform(body ?? {});
    const { deviceCode, userCode } = await createDeviceCode(this.db, input.client_name);
    const shown = formatUserCode(userCode);
    return {
      device_code: deviceCode,
      user_code: shown,
      verification_uri: `${this.webOrigin}/device`,
      verification_uri_complete: `${this.webOrigin}/device?code=${encodeURIComponent(shown)}`,
      expires_in: DEVICE_CODE_TTL_S,
      interval: DEVICE_POLL_INTERVAL_S,
    };
  }

  @Public()
  @Post('device/token')
  async token(@Req() req: Request, @Body() body: unknown, @Res() res: Response): Promise<void> {
    if (!this.polls.allow(clientIp(req))) return tokenError(res, 'slow_down');
    const parsed = DeviceTokenRequestSchema.safeParse(body ?? {});
    if (!parsed.success) return tokenError(res, 'invalid_request');
    const result = await exchangeDeviceCode(this.db, parsed.data.device_code);
    if (!result.ok) return tokenError(res, result.error);
    res.status(200).set('Cache-Control', 'no-store').json(result.response);
  }

  /**
   * "Build in VS Code" (web session + CSRF; never a bearer): a device code approved for you right
   * away, for the vscode:// link. Same rules as typing the code: single use, 10 minutes.
   */
  @Post('handoff')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async handoff(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<ExtHandoff> {
    const { deviceCode, userCode } = await createDeviceCode(this.db, HANDOFF_CLIENT);
    if (!(await decideDevice(tx, caller.userId, userCode, 'approve'))) {
      throw new ApiError(500, 'INTERNAL_ERROR', { detail: 'Could not start VS Code sign-in.' });
    }
    return { device_code: deviceCode, expires_in: DEVICE_CODE_TTL_S };
  }

  @Get('device')
  @Header('Cache-Control', 'no-store')
  async lookup(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Query('user_code') raw: unknown,
  ): Promise<DeviceLookup> {
    const code = typeof raw === 'string' ? normalizeUserCode(raw) : null;
    if (!code) throw notFound();
    const found = await lookupDevice(tx, caller.userId, code);
    if (!found) throw notFound();
    return found;
  }

  @Post('device/approve')
  @HttpCode(204)
  async approve(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(DeviceApproveSchema)) body: DeviceApprove,
  ): Promise<void> {
    const code = normalizeUserCode(body.user_code);
    if (!code) {
      throw validationFailed(
        [{ field: 'user_code', message: 'Codes look like ABCD-2345' }],
        'That code is not valid.',
      );
    }
    if (!(await decideDevice(tx, caller.userId, code, body.decision))) {
      throw new ApiError(404, 'NOT_FOUND', {
        detail: 'This code has expired or was already used. Start sign-in again in VS Code.',
      });
    }
  }

  @BearerAllowed()
  @Get('tokens')
  @Header('Cache-Control', 'no-store')
  async tokens(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<{ items: ExtToken[] }> {
    return { items: await listTokens(tx, caller.userId) };
  }

  @BearerAllowed()
  @Delete('tokens/:id')
  @HttpCode(204)
  async revoke(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @AfterCommit() afterCommit: AfterCommitFn,
  ): Promise<void> {
    if (!isUuid(id) || !(await revokeToken(tx, caller.userId, id.toLowerCase()))) {
      throw notFound();
    }
    // Revoked tokens stop working at once on this instance (others: within the cache TTL).
    afterCommit(() => this.bearer.forget());
  }
}
