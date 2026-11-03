import { Controller, Get, Header, HttpCode, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  FILE_MAX_BYTES,
  type FileRef,
  formatBytes,
  type UploadQuery,
  UploadQuerySchema,
  type UploadType,
} from '@parallelflow/contracts';
import { recordArenaEvent, type Tx } from '@parallelflow/db';
import type { Request, Response } from 'express';
import { ARENA_POST, hasCapability } from '../arenas/messages.js';
import { ARENA_READ } from '../bridge/bridge.js';
import { Caller, DbTx, ProjectScoped } from '../pipeline/decorators.js';
import { ApiError, notFound, validationFailed } from '../pipeline/errors.js';
import { type CallerContext, isUuid } from '../pipeline/request-context.js';
import { ZodPipe } from '../pipeline/validation.js';
import { type BlobOwner, fileRef, putBlob, readFile } from './blobs.js';
import { sendFile } from './download.js';
import { matchesType } from './sniff.js';

// Uploads (build step 6, Phase A; additive to openapi_v2.yaml, which keeps the pre-signed
// POST /files for the S3 story). The body is the raw file (Content-Type: application/octet-stream,
// at most 10 MB, app.ts), with `name` and `mime_type` in the query. The type must be on the
// allowlist and the bytes must match it (magic bytes). Stored in Postgres (SLICE_DEBT), deduplicated
// per owner. No virus scan yet (SLICE_DEBT). A file is attached by sending its id with a message.
//   POST /private/files                       your Private space (user scope)
//   GET  /private/files/:fileId               download (owner)
//   POST /projects/:projectId/files           an arena (cap arena.post)
//   GET  /projects/:projectId/files/:fileId   download (cap arena.read)
// Mutations need CSRF (AuthGuard). Uploads are naturally idempotent (same bytes → same file id).

function bodyBytes(req: Request): Buffer {
  const body: unknown = req.body;
  if (!Buffer.isBuffer(body)) {
    throw validationFailed(
      [{ field: 'body', message: 'Send the file as application/octet-stream' }],
      'Send the file itself as the request body.',
    );
  }
  if (body.length === 0) {
    throw validationFailed([{ field: 'body', message: 'The file is empty' }]);
  }
  if (body.length > FILE_MAX_BYTES) {
    throw validationFailed([{ field: 'body', message: `At most ${formatBytes(FILE_MAX_BYTES)}` }]);
  }
  return body;
}

async function store(tx: Tx, owner: BlobOwner, req: Request, query: UploadQuery): Promise<FileRef> {
  const bytes = bodyBytes(req);
  const type = query.mime_type as UploadType;
  if (!matchesType(bytes, type)) {
    throw validationFailed(
      [{ field: 'mime_type', message: 'The file content does not match its type' }],
      'This file does not look like what its name says.',
    );
  }
  return fileRef(await putBlob(tx, owner, { bytes, contentType: type, name: query.name }));
}

async function download(tx: Tx, owner: BlobOwner, fileId: string, res: Response): Promise<void> {
  if (!isUuid(fileId)) throw notFound();
  const file = await readFile(tx, owner, fileId.toLowerCase());
  if (!file) throw notFound();
  sendFile(res, {
    content: file.content,
    contentType: file.content_type,
    name: file.name ?? 'file',
  });
}

@Controller('private/files')
export class PrivateFilesController {
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  upload(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Req() req: Request,
    @Query(new ZodPipe(UploadQuerySchema)) query: UploadQuery,
  ): Promise<FileRef> {
    return store(tx, { user: caller.userId }, req, query);
  }

  @Get(':fileId')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    await download(tx, { user: caller.userId }, fileId, res);
  }
}

/**
 * A blob in an arena belongs to the arena's hidden org (ADR-029: one org per arena, so the verified
 * project membership's org is the arena's).
 */
@Controller('projects/:projectId/files')
@ProjectScoped('projectId')
export class ArenaFilesController {
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  async upload(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @Query(new ZodPipe(UploadQuerySchema)) query: UploadQuery,
  ): Promise<FileRef> {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    if (!(await hasCapability(tx, projectId.toLowerCase(), caller.userId, ARENA_POST))) {
      throw new ApiError(403, 'FORBIDDEN', {
        detail: 'You can read this arena but not post files.',
        requiredPermission: `cap ${ARENA_POST}`,
      });
    }
    const ref = await store(tx, { org: caller.orgId }, req, query);
    // The activity log (ADR-044): name, type and size only.
    await recordArenaEvent(
      tx,
      { orgId: caller.orgId, projectId: projectId.toLowerCase() },
      { type: 'user', id: caller.userId },
      {
        action: 'file.uploaded',
        target: { type: 'file', id: ref.file_id },
        metadata: { name: ref.name, mime_type: ref.mime_type, size_bytes: ref.size_bytes },
      },
    );
    return ref;
  }

  @Get(':fileId')
  async get(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Param('fileId') fileId: string,
    @Res() res: Response,
  ): Promise<void> {
    if (!caller.orgId) throw new Error('Project-scoped route without an org');
    if (!(await hasCapability(tx, projectId.toLowerCase(), caller.userId, ARENA_READ))) {
      throw notFound();
    }
    await download(tx, { org: caller.orgId }, fileId, res);
  }
}
