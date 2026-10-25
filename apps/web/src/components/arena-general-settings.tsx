'use client';

import type { ArenaSummary } from '@parallelflow/contracts';
import { apiPost } from '../lib/api-browser';
import { useRouter } from 'next/navigation';
import { useArenaActions } from './arena-actions';

// Arena settings → General (owner only, ADR-038): the arena's name, archive / unarchive, and delete
// in a separate danger zone. The same actions as the sidebar's row menu (arena-actions.tsx).

export function ArenaGeneralSettings({ arena }: { arena: ArenaSummary }) {
  const router = useRouter();
  const { dialogs, open } = useArenaActions(arena);
  return (
    <section aria-labelledby="arena-general" className="mx-auto max-w-[1072px] px-6 pt-8">
      <h2 id="arena-general" className="text-[22px] font-bold text-text">
        Arena
      </h2>
      <div className="card mt-4 divide-y divide-line">
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-text">Name</div>
            <div className="truncate text-[14px] text-muted">{arena.name}</div>
          </div>
          <button type="button" className="btn h-9 px-4" onClick={() => open('rename')}>
            Rename
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-text">{arena.archived ? 'Archived' : 'Archive'}</div>
            <div className="text-[14px] text-muted">
              {arena.archived
                ? 'This arena is read-only. Unarchive it to post, push files and request gates again.'
                : 'Make the arena read-only for everyone. You can unarchive it at any time.'}
            </div>
          </div>
          <button
            type="button"
            className="btn h-9 px-4"
            onClick={() =>
              arena.archived
                ? void apiPost(`/arenas/${encodeURIComponent(arena.id)}/unarchive`).then(() =>
                    router.refresh(),
                  )
                : open('archive')
            }
          >
            {arena.archived ? 'Unarchive' : 'Archive'}
          </button>
        </div>
      </div>
      <h3 className="mt-8 text-[15px] font-semibold text-bad">Danger zone</h3>
      <div className="card mt-2 flex flex-wrap items-center gap-4 border-bad-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-text">Delete this arena</div>
          <div className="text-[14px] text-muted">
            It disappears for every member, with its chat and files. A record is kept for audit.
          </div>
        </div>
        <button type="button" className="btn danger h-9 px-4" onClick={() => open('delete')}>
          Delete arena
        </button>
      </div>
      {dialogs}
    </section>
  );
}
