import {
  type Artifact,
  countActions,
  type FolderPushArenaFile,
  type FolderPushItem,
  type FolderPushSource,
  folderPushCard,
  type LinkedArena,
  planFolderPush,
  type PushFolder,
  type PushFolderPreview,
  type PushFolderPreviewRequest,
  type PushFolderResult,
} from '@parallelflow/contracts';
import { emit, notify, requestStageGate, type Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import {
  addVersion,
  type ArtifactHome,
  createArtifact,
  versionContent,
} from '../artifacts/artifacts.js';
import { ARENA_POST, arenaIdOf, hasCapability, insertArenaCard } from '../arenas/messages.js';
import { gateAvailable, gateRefusal } from '../loop/loop.js';
import { ApiError, validationFailed } from '../pipeline/errors.js';
import { getChat } from '../private/chats.js';
import {
  ARTIFACT_PUSH,
  arenaInfo,
  arenaLabel,
  arenaStage,
  forbidden,
  inArena,
  linkOf,
  pushableArenas,
  scopeMismatch,
  setLink,
  toDestination,
} from './bridge.js';

// Push a folder to an arena (contracts folder-push.ts): the files of one folder of a private chat
// go to the arena in one transaction, kept as a folder. The plan (names, new / new version /
// unchanged) is pure; this file reads what it needs and writes the result:
//   * your files and their content, in your user scope (owner only, this chat only);
//   * in the arena's verified tenant (membership + artifact.push): the arena's files, then one new
//     file or version per changed file, ONE bridge_events row (ids and numbers only), ONE arena card
//     listing the files, one Inbox notification, the optional gate request, artifact.pushed events;
//   * back in user scope: copies in step with their arena file (ADR-041), and the chat's link
//     (write-once) when it had none.
// The arena's git snapshot is written when a gate is approved (repo/snapshot.ts), so the batch
// lands in one commit then, under docs/<stage>/<folders>/.

interface Source extends FolderPushSource {
  kind: Artifact['kind'];
}

interface SourceRow {
  id: string;
  name: string;
  kind: Artifact['kind'];
  lineage_id: string;
  head_version_no: number;
  upstream_project_id: string | null;
  upstream_artifact_id: string | null;
  upstream_version_no: number | null;
  sha256: string;
}

/** Your files of this chat, in the order asked (user scope). Any other id is a 400. */
async function readSources(
  tx: Tx,
  userId: string,
  chatId: string,
  ids: readonly string[],
): Promise<Source[]> {
  const { rows } = await sql<SourceRow>`
    SELECT a.id, a.name, a.kind, a.lineage_id, a.head_version_no,
           a.upstream_project_id, a.upstream_artifact_id, a.upstream_version_no,
           v.blob_sha256 AS sha256
      FROM artifacts a
      JOIN artifact_versions v ON v.artifact_id = a.id AND v.version_no = a.head_version_no
     WHERE a.id = ANY(${[...ids]}::uuid[]) AND a.scope = 'private'
       AND a.owner_user_id = ${userId} AND a.private_session_id = ${chatId}
       AND a.deleted_at IS NULL`.execute(tx);
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (byId.size !== ids.length) {
    throw validationFailed(
      [{ field: 'artifact_ids', message: 'Every file must be one of yours in this chat' }],
      'Some of these files are not in this chat any more. Refresh and try again.',
    );
  }
  return ids.map((id) => {
    const r = byId.get(id) as SourceRow;
    return {
      artifact_id: r.id,
      version_no: r.head_version_no,
      name: r.name,
      kind: r.kind,
      lineage_id: r.lineage_id,
      sha256: r.sha256,
      upstream:
        r.upstream_project_id && r.upstream_artifact_id && r.upstream_version_no
          ? {
              project_id: r.upstream_project_id,
              artifact_id: r.upstream_artifact_id,
              version_no: r.upstream_version_no,
            }
          : null,
    };
  });
}

/** The arena's files now, newest first (the arena's verified tenant). */
async function readArenaFiles(tx: Tx, projectId: string): Promise<FolderPushArenaFile[]> {
  const { rows } = await sql<FolderPushArenaFile>`
    SELECT a.id, a.name, a.lineage_id, a.head_version_no, v.blob_sha256 AS sha256
      FROM artifacts a
      JOIN artifact_versions v ON v.artifact_id = a.id AND v.version_no = a.head_version_no
     WHERE a.project_id = ${projectId} AND a.scope = 'project' AND a.deleted_at IS NULL
     ORDER BY a.updated_at DESC, a.id`.execute(tx);
  return rows;
}

async function planIn(tx: Tx, projectId: string, sources: readonly Source[]) {
  const arenaFiles = await readArenaFiles(tx, projectId);
  const stage = await arenaStage(tx, projectId);
  return { plan: planFolderPush({ projectId, stage, sources, arenaFiles }), arenaFiles };
}

/** POST /private/sessions/{id}/bridge/push-folder/preview (owner; no writes). */
export async function pushFolderPreview(
  tx: Tx,
  userId: string,
  chatId: string,
  input: PushFolderPreviewRequest,
): Promise<PushFolderPreview> {
  await getChat(tx, userId, chatId);
  const sources = await readSources(tx, userId, chatId, input.artifact_ids);
  const linked = await linkOf(tx, userId, chatId);
  let arenas: LinkedArena[];
  if (linked) {
    arenas = await inArena(tx, { userId, projectId: linked }, async () =>
      (await hasCapability(tx, linked, userId, ARTIFACT_PUSH)) ? [await arenaInfo(tx, linked)] : [],
    ).catch(() => []);
  } else {
    arenas = await pushableArenas(tx, userId);
  }
  if (linked && input.project_id && input.project_id !== linked) {
    const current = arenas[0];
    throw scopeMismatch(current ? arenaLabel(current) : 'another arena');
  }
  const targetId = input.project_id ?? linked ?? (arenas.length === 1 ? arenas[0]?.id : undefined);
  const destination = arenas.find((a) => a.id === targetId) ?? null;
  if (targetId && !destination && input.project_id) {
    throw forbidden(ARTIFACT_PUSH, 'You cannot push files to this arena.');
  }

  let files: FolderPushItem[] = [];
  let gate: PushFolderPreview['gate_available'] = null;
  if (destination) {
    [files, gate] = await inArena(tx, { userId, projectId: destination.id }, async () => [
      (await planIn(tx, destination.id, sources)).plan,
      await gateAvailable(tx, destination.id, userId),
    ]);
  }
  return {
    destination: destination && toDestination(destination),
    destination_locked: Boolean(linked),
    arenas: arenas.map(toDestination),
    folder: input.folder,
    files,
    counts: countActions(files),
    binds_session: !linked,
    gate_available: gate,
  };
}

const newerConflict = (names: string[]) =>
  new ApiError(409, 'CONFLICT', {
    detail: `${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''} changed in the arena since your copy. Review, then choose Replace with mine.`,
  });

/**
 * POST /private/sessions/{id}/bridge/push-folder (owner + artifact.push; @Idempotent, CSRF). One
 * transaction (see the top of this file). Files whose content did not change are left as they are;
 * when nothing changed there is no card, no event and no notification.
 */
export async function pushFolder(
  tx: Tx,
  userId: string,
  chatId: string,
  input: PushFolder,
): Promise<PushFolderResult> {
  await getChat(tx, userId, chatId);
  const linked = await linkOf(tx, userId, chatId);
  if (linked && linked !== input.project_id) throw scopeMismatch('another arena');
  const sources = await readSources(tx, userId, chatId, input.artifact_ids);
  // Content is read in your scope, before entering the arena's.
  const home: ArtifactHome = { kind: 'private', userId };
  const texts = new Map<string, string>();
  for (const s of sources) {
    texts.set(s.artifact_id, (await versionContent(tx, home, s.artifact_id, s.version_no)).text);
  }

  const result = await inArena(tx, { userId, projectId: input.project_id }, async (orgId) => {
    const projectId = input.project_id;
    if (!(await hasCapability(tx, projectId, userId, ARTIFACT_PUSH))) {
      throw forbidden(ARTIFACT_PUSH, 'You cannot push files to this arena.');
    }
    const { plan, arenaFiles } = await planIn(tx, projectId, sources);
    const newer = plan.filter((i) => i.newer && i.action === 'new_version');
    if (newer.length > 0 && !input.replace_newer) {
      throw newerConflict(newer.map((i) => i.arena_name));
    }

    const arenaHome = { kind: 'project' as const, userId, orgId, projectId };
    const author = { type: 'user' as const, id: userId };
    const lineages = new Set(arenaFiles.map((f) => f.lineage_id));
    const out: PushFolderResult['files'] = [];
    const pushed: {
      artifactId: string;
      versionNo: number;
      versionId: string;
      mode: string;
      from: Source;
    }[] = [];
    for (const item of plan) {
      const s = sources.find((x) => x.artifact_id === item.artifact_id) as Source;
      if (item.action === 'unchanged' && item.existing_artifact_id) {
        out.push({
          artifact_id: item.existing_artifact_id,
          name: item.arena_name,
          version_no: item.existing_version_no ?? 1,
          action: 'unchanged',
        });
        continue;
      }
      const source = {
        type: 'push' as const,
        artifact_id: s.artifact_id,
        version_no: s.version_no,
        private_session_id: chatId,
      };
      const content = texts.get(s.artifact_id) ?? '';
      let artifactId: string;
      let versionNo: number;
      let versionId: string;
      if (item.action === 'new_version' && item.existing_artifact_id) {
        const added = await addVersion(
          tx,
          arenaHome,
          item.existing_artifact_id,
          { content },
          author,
          source,
        );
        artifactId = item.existing_artifact_id;
        versionNo = added.version.version_no;
        versionId = added.versionId;
      } else {
        // The private file's lineage when the arena does not have it yet (one copy per lineage).
        const lineageFree = !lineages.has(s.lineage_id);
        const created = await createArtifact(
          tx,
          arenaHome,
          {
            kind: s.kind,
            name: item.arena_name,
            content,
            ...(lineageFree && { lineageId: s.lineage_id }),
          },
          author,
          source,
        );
        lineages.add(s.lineage_id);
        artifactId = created.artifact.id;
        versionNo = 1;
        versionId = created.versionId;
      }
      out.push({
        artifact_id: artifactId,
        name: item.arena_name,
        version_no: versionNo,
        action: item.action,
      });
      pushed.push({ artifactId, versionNo, versionId, mode: item.action, from: s });
    }

    let messageId: string | null = null;
    let approvalId: string | null = null;
    const first = pushed[0];
    if (first) {
      await tx
        .insertInto('bridge_events')
        .values({
          org_id: orgId,
          user_id: userId,
          private_session_id: chatId,
          project_id: projectId,
          direction: 'push_artifact',
          // Ids and numbers only, never content or names.
          ref: JSON.stringify({
            batch: true,
            files: pushed.map((p) => ({
              artifact_id: p.from.artifact_id,
              version_no: p.from.version_no,
              arena_artifact_id: p.artifactId,
              arena_version_no: p.versionNo,
              mode: p.mode,
            })),
          }),
        })
        .execute();

      const me = await tx
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', userId)
        .executeTakeFirst();
      const who = me?.display_name ?? 'A teammate';
      if (await hasCapability(tx, projectId, userId, ARENA_POST)) {
        messageId = await insertArenaCard(tx, {
          orgId,
          arenaId: await arenaIdOf(tx, projectId),
          userId,
          body: folderPushCard(who, input.folder, pushed.length),
          artifactRefs: pushed.map((p) => p.artifactId),
        });
      }
      await notify(tx, {
        orgId,
        projectId,
        type: 'artifact_push',
        title: folderPushCard(who, input.folder, pushed.length).replace(/ from Private$/, ''),
        resourceType: 'artifact',
        resourceId: first.artifactId,
        deepLink: `/arena/${projectId}?artifact=${first.artifactId}`,
        actor: { type: 'user', id: userId },
        dedupeKey: `push:${first.versionId}`,
        recipients: { members: true },
      });
      for (const p of pushed) {
        await emit(tx, {
          type: 'artifact.pushed',
          org_id: orgId,
          subject: p.artifactId,
          actor: { type: 'user', id: userId, on_behalf_of: null },
          data: {
            artifact_id: p.artifactId,
            artifact_version_id: p.versionId,
            project_id: projectId,
            private_session_id: chatId,
          },
        });
      }
    }

    // "Request the <STAGE> gate after pushing": same transaction, after the card.
    const gateFile = first?.artifactId ?? out[0]?.artifact_id;
    if (input.request_gate && gateFile) {
      const gate = await requestStageGate(tx, {
        orgId,
        projectId,
        actor: { type: 'user', id: userId },
        artifactId: gateFile,
        requireCapability: true,
      });
      if (gate.ok) approvalId = gate.approvalId;
      else if (gate.reason !== 'PENDING') throw gateRefusal(gate.reason);
    }

    // Copies that are now in step with their arena file (ADR-041).
    const inStep = plan.flatMap((item, i) => {
      const s = sources.find((x) => x.artifact_id === item.artifact_id);
      const done = out[i];
      return s?.upstream && s.upstream.artifact_id === item.existing_artifact_id && done
        ? [{ id: s.artifact_id, versionNo: done.version_no }]
        : [];
    });
    return { out, messageId, approvalId, inStep };
  });

  for (const c of result.inStep) {
    await tx
      .updateTable('artifacts')
      .set({ upstream_version_no: c.versionNo })
      .where('id', '=', c.id)
      .where('owner_user_id', '=', userId)
      .where('scope', '=', 'private')
      .execute();
  }
  let bound = false;
  if (!linked) {
    await setLink(tx, userId, chatId, input.project_id);
    bound = true;
  }
  return {
    project_id: input.project_id,
    folder: input.folder,
    files: result.out,
    counts: countActions(result.out),
    approval_id: result.approvalId,
    session_bound: bound,
    message_id: result.messageId,
  };
}
