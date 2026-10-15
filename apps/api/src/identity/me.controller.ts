import { Body, Controller, Get, Header, Patch } from '@nestjs/common';
import { type Me, type UpdateMe, UpdateMeSchema } from '@saras/contracts';
import type { Tx } from '@saras/db';
import { Caller, DbTx } from '../pipeline/decorators.js';
import { ApiError } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import { loadMe } from './me.js';

// GET / PATCH /v1/me (openapi_v2.yaml getMe, updateMe; x-required-permission: authenticated).
// Both run in the caller's user scope (the pipeline's default for unscoped routes). PATCH is a
// mutation, so the session verifier has already checked X-CSRF-Token. Not @Idempotent: doc 07 §7.1
// requires Idempotency-Key on creating and state-transition POSTs only.

@Controller('me')
export class MeController {
  @Get()
  @Header('Cache-Control', 'no-store')
  async get(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<Me> {
    return this.load(tx, caller.userId);
  }

  @Patch()
  @Header('Cache-Control', 'no-store')
  async update(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(UpdateMeSchema)) body: UpdateMe,
  ): Promise<Me> {
    // RLS: in user scope only your own row is updatable. A taken handle → 23505 → 409 ALREADY_EXISTS.
    await tx
      .updateTable('users')
      .set({
        ...(body.display_name !== undefined && { display_name: body.display_name }),
        ...(body.handle !== undefined && { handle: body.handle }),
      })
      .where('id', '=', caller.userId)
      .execute();
    return this.load(tx, caller.userId);
  }

  private async load(tx: Tx, userId: string): Promise<Me> {
    const me = await loadMe(tx, userId);
    // The verifier just checked the account; gone or deactivated meanwhile → sign in again.
    if (!me) throw new ApiError(401, 'UNAUTHENTICATED');
    return me;
  }
}
