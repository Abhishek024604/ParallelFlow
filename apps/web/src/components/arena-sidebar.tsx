'use client';

import type { ArenaSummary } from '@saras/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOptimisticList } from '../lib/optimistic';
import { ArenaKey, cycleLabel } from './arena-bits';
import { Avatar } from './brand';
import { CreateArenaButton } from './create-arena';
import { InboxIcon, PlusIcon } from './icons';

// Arena sidebar (screens 04, 18): Inbox, your arenas (key badge, "Cycle N · STAGE"), New arena,
// and you at the bottom.

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
              const label = cycleLabel(arena);
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
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-text">
                        {arena.name}
                      </span>
                      {label && <span className="block text-[12px] text-faint">{label}</span>}
                    </span>
                  </Link>
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
