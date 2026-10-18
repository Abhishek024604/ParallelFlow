'use client';

import type { ArenaSummary, NotificationPage } from '@saras/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NOTIFICATIONS_CHANGED_EVENT, NOTIFICATIONS_PAGE_EVENT } from '../lib/notifications';
import { useOptimisticList } from '../lib/optimistic';
import { ArenaKey, cycleLabel } from './arena-bits';
import { ArenaFiles } from './arena-files';
import { Avatar } from './brand';
import { CreateArenaButton } from './create-arena';
import { InboxIcon, PlusIcon } from './icons';

// Arena sidebar (screens 04, 18): Inbox, your arenas (key badge, "Cycle N · STAGE"; the current
// arena lists its Files), New arena, and you at the bottom. Each arena shows how many messages
// arrived since you last opened it (from the top bar's Inbox poll, NOTIFICATIONS_PAGE_EVENT).

/** Unread messages per arena, kept in step with the Inbox bell's poll. */
function useArenaUnread(): ReadonlyMap<string, number> {
  const [unread, setUnread] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    const onPage = (event: Event) => {
      const page = (event as CustomEvent<NotificationPage>).detail;
      if (!page?.arena_unread) return;
      setUnread(new Map(page.arena_unread.map((a) => [a.project_id, a.count])));
    };
    window.addEventListener(NOTIFICATIONS_PAGE_EVENT, onPage);
    // Ask the bell for a fresh page now (it may have loaded before this sidebar mounted).
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
    return () => window.removeEventListener(NOTIFICATIONS_PAGE_EVENT, onPage);
  }, []);
  return unread;
}

export function ArenaSidebar({
  arenas: serverArenas,
  user,
}: {
  arenas: ArenaSummary[];
  user: { display_name: string; email: string };
}) {
  const pathname = usePathname();
  // An arena being created shows at once (create-arena.tsx announces it).
  const arenas = useOptimisticList('arenas', serverArenas, false);
  const unread = useArenaUnread();
  return (
    <aside
      aria-label="Arenas"
      className="flex w-[260px] shrink-0 flex-col border-r border-line bg-side px-3 pb-3 pt-4"
    >
      <Link
        href="/inbox"
        aria-current={pathname === '/inbox' ? 'page' : undefined}
        className="nav flex h-9 w-full items-center gap-3 px-3 text-left text-[15px] text-text no-underline"
      >
        <InboxIcon />
        Inbox
      </Link>

      <h2 className="label mt-6 px-3">Arenas</h2>
      <nav aria-label="Your arenas" className="mt-2 min-h-0 flex-1 overflow-y-auto">
        {arenas.length === 0 ? (
          <p className="px-3 py-1.5 text-[13px] text-faint">No arenas yet</p>
        ) : (
          <ul className="space-y-0.5">
            {arenas.map((arena) => {
              const active = pathname === `/arena/${arena.id}`;
              const inArena = active || pathname.startsWith(`/arena/${arena.id}/`);
              const label = cycleLabel(arena);
              // The arena you are in is being read: no badge for it.
              const count = active ? 0 : (unread.get(arena.id) ?? 0);
              if (arena.pending) {
                return (
                  <li key={arena.id} aria-busy="true">
                    <span className="nav flex items-center gap-3 px-2.5 py-2 opacity-60">
                      <ArenaKey arenaKey={arena.key} />
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium text-text">
                          {arena.name}
                        </span>
                        <span className="block text-[12px] text-faint">Creating…</span>
                      </span>
                    </span>
                  </li>
                );
              }
              return (
                <li key={arena.id}>
                  <Link
                    href={`/arena/${arena.id}`}
                    aria-current={active ? 'page' : undefined}
                    className={`nav flex items-center gap-3 px-2.5 py-2 no-underline ${
                      active ? 'bg-panel shadow-card' : ''
                    }`}
                  >
                    <ArenaKey arenaKey={arena.key} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[14px] text-text ${
                          count > 0 ? 'font-bold' : 'font-medium'
                        }`}
                      >
                        {arena.name}
                      </span>
                      {label && <span className="block text-[12px] text-faint">{label}</span>}
                    </span>
                    {count > 0 && (
                      <span
                        aria-label={`${count} unread ${count === 1 ? 'message' : 'messages'}`}
                        className="ml-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-ink px-1.5 text-[11px] font-semibold text-on-ink"
                      >
                        {count > 99 ? '99+' : count}
                      </span>
                    )}
                  </Link>
                  {inArena && <ArenaFiles projectId={arena.id} />}
                </li>
              );
            })}
          </ul>
        )}
        <CreateArenaButton className="nav mt-1 flex h-9 w-full items-center gap-3 px-3 text-left text-[15px] text-text">
          <PlusIcon />
          New arena
        </CreateArenaButton>
      </nav>

      <div className="mt-3 flex items-center gap-3 border-t border-line px-2 pt-3">
        <Avatar name={user.display_name} size={36} />
        <div className="min-w-0">
          <div className="truncate font-semibold text-text">{user.display_name}</div>
          <div className="truncate text-[12px] text-faint">{user.email}</div>
        </div>
      </div>
    </aside>
  );
}
