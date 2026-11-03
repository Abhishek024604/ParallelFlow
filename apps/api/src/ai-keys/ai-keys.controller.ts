import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Put,
} from '@nestjs/common';
import {
  AI_PROVIDER_NAMES,
  type AiKeyStatus,
  type AiProviderList,
  type SaveAiKey,
  SaveAiKeySchema,
} from '@parallelflow/contracts';
import { recordArenaEvent, type Tx } from '@parallelflow/db';
import { isArenaOwner, requireActiveArena, requireArenaOwner } from '../arenas/arena-admin.js';
import { hasCapability } from '../arenas/messages.js';
import { ARENA_READ } from '../bridge/bridge.js';
import { Caller, DbTx, ProjectScoped } from '../pipeline/decorators.js';
import { ApiError } from '../pipeline/errors.js';
import type { CallerContext } from '../pipeline/request-context.js';
import { CONNECTION_KEY } from '../pipeline/tokens.js';
import { ZodPipe } from '../pipeline/validation.js';
import { checkKey, keyStatus, knowsModel, listProviders, removeKey, saveKey } from './ai-keys.js';

// Bring your own AI key (ADR-043). Additive to openapi_v2.yaml (Phase A). Mutations need CSRF
// (AuthGuard). Responses never carry the key: provider, model and its last 4 only.
//   GET    /ai-providers                  signed in → AiProviderList (Pi's catalogue)
//   GET    /me/ai-key                     your own key (user scope, owner-only RLS) → AiKeyStatus
//   PUT    /me/ai-key                     checked with the provider once, then sealed → AiKeyStatus
//   DELETE /me/ai-key                     back to ParallelFlow's AI → AiKeyStatus
//   GET    /projects/:p/ai-key            cap arena.read → AiKeyStatus (can_edit: owner)
//   PUT    /projects/:p/ai-key            owner, active arena → AiKeyStatus
//   DELETE /projects/:p/ai-key            owner → AiKeyStatus

/** 422 with a plain message on one field. */
function refused(field: 'api_key' | 'model', message: string): ApiError {
  return new ApiError(422, 'PRECONDITION_FAILED', {
    detail: message,
    errors: [{ field, message }],
  });
}

/** The model must be one the runtime knows; the key must be one the provider accepts. */
async function checkInput(body: SaveAiKey): Promise<void> {
  const name = AI_PROVIDER_NAMES[body.provider];
  if (!(await knowsModel(body.provider, body.model))) {
    throw refused(
      'model',
      `ParallelFlow can't use that ${name} model yet. Choose one from the list.`,
    );
  }
  const check = await checkKey(body.provider, body.api_key);
  if (check === 'refused') throw refused('api_key', `${name} did not accept this key.`);
  if (check === 'unreachable') {
    throw refused('api_key', `Could not reach ${name} to check the key. Try again.`);
  }
}

@Controller('ai-providers')
export class AiProvidersController {
  @Get()
  @Header('Cache-Control', 'private, max-age=3600')
  list(): Promise<AiProviderList> {
    return listProviders();
  }
}

@Controller('me/ai-key')
export class MyAiKeyController {
  constructor(@Inject(CONNECTION_KEY) private readonly key: Buffer) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<AiKeyStatus> {
    return keyStatus(tx, { kind: 'user', userId: caller.userId }, true);
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  async save(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(SaveAiKeySchema)) body: SaveAiKey,
  ): Promise<AiKeyStatus> {
    await checkInput(body);
    const owner = { kind: 'user', userId: caller.userId } as const;
    await saveKey(tx, this.key, owner, caller.userId, {
      provider: body.provider,
      model: body.model,
      apiKey: body.api_key,
    });
    return keyStatus(tx, owner, true);
  }

  @Delete()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async remove(@DbTx() tx: Tx, @Caller() caller: CallerContext): Promise<AiKeyStatus> {
    const owner = { kind: 'user', userId: caller.userId } as const;
    await removeKey(tx, owner);
    return keyStatus(tx, owner, true);
  }
}

function scope(caller: CallerContext, projectId: string) {
  if (!caller.orgId) throw new Error('Project-scoped route without an org');
  return { orgId: caller.orgId, projectId: projectId.toLowerCase() };
}

@Controller('projects/:projectId/ai-key')
@ProjectScoped('projectId')
export class ArenaAiKeyController {
  constructor(@Inject(CONNECTION_KEY) private readonly key: Buffer) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<AiKeyStatus> {
    const s = scope(caller, projectId);
    if (!(await hasCapability(tx, s.projectId, caller.userId, ARENA_READ))) {
      throw new ApiError(403, 'FORBIDDEN', { requiredPermission: `cap ${ARENA_READ}` });
    }
    const owner = await isArenaOwner(tx, s.projectId, caller.userId);
    return keyStatus(tx, { kind: 'project', projectId: s.projectId }, owner);
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  async save(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(SaveAiKeySchema)) body: SaveAiKey,
  ): Promise<AiKeyStatus> {
    const s = scope(caller, projectId);
    await requireArenaOwner(tx, s.projectId, caller.userId, "change the arena's AI key");
    await requireActiveArena(tx, s.projectId);
    await checkInput(body);
    await saveKey(
      tx,
      this.key,
      { kind: 'project', projectId: s.projectId, orgId: s.orgId },
      caller.userId,
      { provider: body.provider, model: body.model, apiKey: body.api_key },
    );
    // The activity log names the provider and model only: never the key or its last characters.
    await recordArenaEvent(
      tx,
      s,
      { type: 'user', id: caller.userId },
      {
        action: 'arena.ai_key.set',
        target: { type: 'ai_key', id: s.projectId },
        metadata: { provider: body.provider, model: body.model },
      },
    );
    return keyStatus(tx, { kind: 'project', projectId: s.projectId }, true);
  }

  @Delete()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async remove(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<AiKeyStatus> {
    const s = scope(caller, projectId);
    await requireArenaOwner(tx, s.projectId, caller.userId, "change the arena's AI key");
    await removeKey(tx, { kind: 'project', projectId: s.projectId });
    await recordArenaEvent(
      tx,
      s,
      { type: 'user', id: caller.userId },
      {
        action: 'arena.ai_key.removed',
        target: { type: 'ai_key', id: s.projectId },
      },
    );
    return keyStatus(tx, { kind: 'project', projectId: s.projectId }, true);
  }
}
