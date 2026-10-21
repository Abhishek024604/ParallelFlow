import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  type ApproveVersion,
  ApproveVersionSchema,
  type Artifact,
  type ArtifactList,
  type ArtifactVersion,
  type ArtifactVersionList,
  type CreateArtifact,
  CreateArtifactSchema,
  type ListArtifactsQuery,
  ListArtifactsQuerySchema,
  type NewVersion,
  NewVersionSchema,
  type PushPreview,
  type PushPreviewQuery,
  PushPreviewQuerySchema,
  type PushRequest,
  PushRequestSchema,
  type PushResult,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import type { Response } from 'express';
import { hasCapability } from '../arenas/messages.js';
import { ARENA_READ, pushArtifact, pushPreview } from '../bridge/bridge.js';
import { sendFile } from '../files/download.js';
import {
  Caller,
  DbTx,
  Idempotent,
  ProjectScoped,
  TouchProject,
  type TouchProjectFn,
} from '../pipeline/decorators.js';
import { notFound, validationFailed } from '../pipeline/errors.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import { getChat } from '../private/chats.js';
import {
  addVersion,
  approveVersion,
  type ArtifactHome,
  createArtifact,
  getArtifact,
  listArtifacts,
  listVersions,
  requireEdit,
  versionContent,
} from './artifacts.js';

// Artifacts (build step 6; openapi_v2.yaml Artifacts tag). Private ones on /artifacts (owner only,
// user scope: someone else's id is 404). Arena ones on the additive /projects/{id}/artifacts paths
// (@ProjectScoped: read needs arena.read, write needs artifact.edit). Content is markdown text,
// at most 2 MB; versions are immutable drafts until gates (step 7) approve one.
//   GET  /artifacts?scope=private&private_session_id=      yours
//   POST /artifacts                                         new private file (v1)
//   GET  /artifacts/:id | /:id/versions | /:id/versions/:no/content
//   POST /artifacts/:id/versions                            new version
//   POST /artifacts/:id/approve                             you approve your file's latest version
//   GET  /artifacts/:id/push-preview?project_id=&version_no=
//   POST /artifacts/:id/push                                the bridge (bridge.ts)
//   …and the same reads and writes under /projects/:projectId/artifacts, plus
//   POST /projects/:projectId/artifacts/:id/approve           the owner approves the latest version

function pathId(value: string): string {
  if (!isUuid(value)) throw notFound();
  return value.toLowerCase();
}

function versionNo(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000) throw notFound();
  return n;
}

const author = (caller: CallerContext) => ({ type: 'user' as const, id: caller.userId });

function sendVersion(res: Response, artifact: Artifact, text: string) {
  sendFile(res, {
    content: Buffer.from(text, 'utf8'),
    contentType: 'text/markdown',
    name: artifact.name.includes('.') ? artifact.name : `${artifact.name}.md`,
  });
}

@Controller('artifacts')
export class PrivateArtifactsController {
  private home(caller: CallerContext): ArtifactHome {
    return { kind: 'private', userId: caller.userId };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Query(new ZodPipe(ListArtifactsQuerySchema)) query: ListArtifactsQuery,
  ): Promise<ArtifactList> {
    const filter = query.private_session_id ? { privateSessionId: query.private_session_id } : {};
    return { items: await listArtifacts(tx, this.home(caller), filter), next_cursor: null };
  }

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async create(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Body(new ZodPipe(CreateArtifactSchema)) body: CreateArtifact,
  ): Promise<Artifact> {
    if (body.scope !== 'private' || body.project_id) {
      throw validationFailed(
        [{ field: 'scope', message: 'Use POST /projects/{project_id}/artifacts for an arena' }],
        'Arena files are created in the arena, or pushed from Private.',
      );
    }
    if (body.private_session_id) {
      await getChat(tx, caller.userId, body.private_session_id).catch(() => {
        throw validationFailed([{ field: 'private_session_id', message: 'No such chat' }]);
      });
    }
    const { artifact } = await createArtifact(
      tx,
      this.home(caller),
      { ...body, privateSessionId: body.private_session_id ?? null },
      author(caller),
      { type: 'private_session', id: body.private_session_id ?? null },
    );
    return artifact;
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  get(@DbTx() tx: Tx, @Caller() caller: CallerContext, @Param('id') id: string): Promise<Artifact> {
    return getArtifact(tx, this.home(caller), pathId(id));
  }

  @Get(':id/versions')
  @Header('Cache-Control', 'no-store')
  async versions(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
  ): Promise<ArtifactVersionList> {
    return { items: await listVersions(tx, this.home(caller), pathId(id)) };
  }

  @Post(':id/versions')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async newVersion(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(NewVersionSchema)) body: NewVersion,
  ): Promise<ArtifactVersion> {
    const { version } = await addVersion(tx, this.home(caller), pathId(id), body, author(caller), {
      type: 'private_session',
      id: null,
    });
    return version;
  }

  @Get(':id/versions/:no/content')
  async content(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Param('no') no: string,
    @Res() res: Response,
  ): Promise<void> {
    const { artifact, text } = await versionContent(
      tx,
      this.home(caller),
      pathId(id),
      versionNo(no),
    );
    sendVersion(res, artifact, text);
  }

  @Get(':id/push-preview')
  @Header('Cache-Control', 'no-store')
  preview(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Query(new ZodPipe(PushPreviewQuerySchema)) query: PushPreviewQuery,
  ): Promise<PushPreview> {
    return pushPreview(tx, caller.userId, pathId(id), query);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  approve(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('id') id: string,
    @Body(new ZodPipe(ApproveVersionSchema)) body: ApproveVersion,
  ): Promise<Artifact> {
    return approveVersion(tx, this.home(caller), pathId(id), body.version_no);
  }

  @Post(':id/push')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  push(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @TouchProject() touch: TouchProjectFn,
    @Param('id') id: string,
    @Body(new ZodPipe(PushRequestSchema)) body: PushRequest,
  ): Promise<PushResult> {
    touch(body.project_id); // the arena gets the artifact and a stream card
    return pushArtifact(tx, caller.userId, pathId(id), body);
  }
}

@Controller('projects/:projectId/artifacts')
@ProjectScoped('projectId')
export class ArenaArtifactsController {
  private async home(tx: Tx, caller: CallerContext, projectId: string): Promise<ArtifactHome> {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    const id = projectId.toLowerCase();
    // Every member has arena.read today; checked so a future role without it sees nothing.
    if (!(await hasCapability(tx, id, caller.userId, ARENA_READ))) throw notFound();
    return { kind: 'project', userId: caller.userId, orgId: caller.orgId, projectId: id };
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
  ): Promise<ArtifactList> {
    return {
      items: await listArtifacts(tx, await this.home(tx, caller, projectId)),
      next_cursor: null,
    };
  }

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async create(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(CreateArtifactSchema)) body: CreateArtifact,
  ): Promise<Artifact> {
    const home = await this.home(tx, caller, projectId);
    if (body.scope !== 'project' || body.private_session_id) {
      throw validationFailed([{ field: 'scope', message: 'Must be project' }]);
    }
    await requireEdit(tx, home);
    const { artifact } = await createArtifact(tx, home, body, author(caller), {
      type: 'upload',
      id: null,
    });
    return artifact;
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ): Promise<Artifact> {
    return getArtifact(tx, await this.home(tx, caller, projectId), pathId(id));
  }

  @Get(':id/versions')
  @Header('Cache-Control', 'no-store')
  async versions(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
  ): Promise<ArtifactVersionList> {
    return { items: await listVersions(tx, await this.home(tx, caller, projectId), pathId(id)) };
  }

  @Post(':id/versions')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Idempotent()
  async newVersion(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body(new ZodPipe(NewVersionSchema)) body: NewVersion,
  ): Promise<ArtifactVersion> {
    const home = await this.home(tx, caller, projectId);
    await requireEdit(tx, home);
    const { version } = await addVersion(tx, home, pathId(id), body, author(caller), {
      type: 'upload',
      id: null,
    });
    return version;
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async approve(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @TouchProject() touch: TouchProjectFn,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Body(new ZodPipe(ApproveVersionSchema)) body: ApproveVersion,
  ): Promise<Artifact> {
    const home = await this.home(tx, caller, projectId);
    const artifact = await approveVersion(tx, home, pathId(id), body.version_no);
    touch(home.kind === 'project' ? home.projectId : projectId);
    return artifact;
  }

  @Get(':id/versions/:no/content')
  async content(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('id') id: string,
    @Param('no') no: string,
    @Res() res: Response,
  ): Promise<void> {
    const home = await this.home(tx, caller, projectId);
    const { artifact, text } = await versionContent(tx, home, pathId(id), versionNo(no));
    sendVersion(res, artifact, text);
  }
}
