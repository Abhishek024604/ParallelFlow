'use client';

import type { ArenaSummary } from '@parallelflow/contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost, apiSend } from '../lib/api-browser';
import { ConfirmDialog, RenameDialog } from './dialog';
import { RowMenu, type RowMenuItem } from './row-menu';

// The arena owner's actions (ADR-038): rename, archive / unarchive, delete. Used in the sidebar's
// row menu and on the Settings page, so both behave the same. Members see none of them; the API
// refuses them too.

type Dialog = 'rename' | 'archive' | 'delete' | null;

export function useArenaActions(arena: ArenaSummary) {
  const router = useRouter();
  const [dialog, setDialog] = useState<Dialog>(null);
  const path = `/arenas/${encodeURIComponent(arena.id)}`;
  const done = () => router.refresh();

  const items: RowMenuItem[] =
    arena.role === 'owner'
      ? [
          { label: 'Rename', onSelect: () => setDialog('rename') },
          arena.archived
            ? {
                label: 'Unarchive',
                onSelect: () =>
                  void apiPost(`${path}/unarchive`)
                    .then(done)
                    .catch(() => setDialog('archive')),
              }
            : { label: 'Archive', onSelect: () => setDialog('archive') },
          { label: 'Delete arena', danger: true, onSelect: () => setDialog('delete') },
        ]
      : [];

  const dialogs = (
    <>
      {dialog === 'rename' && (
        <RenameDialog
          title="Rename arena"
          label="Arena name"
          initial={arena.name}
          maxLength={80}
          onSave={async (name) => {
            await apiSend('PATCH', path, { name });
            done();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'archive' && (
        <ConfirmDialog
          title={`Archive ${arena.name}?`}
          body={
            <>
              The arena becomes read-only for everyone: no new messages, files or gate requests. It
              stays in the list under Archived, and you can unarchive it at any time.
            </>
          }
          confirmLabel="Archive"
          onConfirm={async () => {
            await apiPost(`${path}/archive`);
            done();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title={`Delete ${arena.name}?`}
          body={
            <>
              The arena, its chat and its files disappear for all {arena.member_count}{' '}
              {arena.member_count === 1 ? 'member' : 'members'}. A record is kept for audit, but
              nobody can open it again. To keep it readable, archive it instead.
            </>
          }
          confirmLabel="Delete arena"
          danger
          confirmText={arena.name}
          onConfirm={async () => {
            await apiSend('DELETE', path);
            router.push('/arena');
            done();
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
  return { items, dialogs, open: setDialog };
}

/** The "⋯" menu of an arena row (owner only; nothing for members). */
export function ArenaRowMenu({ arena }: { arena: ArenaSummary }) {
  const { items, dialogs } = useArenaActions(arena);
  if (!items.length) return null;
  return (
    <>
      <RowMenu label={`Actions for ${arena.name}`} items={items} />
      {dialogs}
    </>
  );
}
