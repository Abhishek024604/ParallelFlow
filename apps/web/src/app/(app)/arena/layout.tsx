import type { ReactNode } from 'react';
import { ArenaSidebar } from '../../../components/arena-sidebar';
import { CreateArenaProvider } from '../../../components/create-arena';
import { getArenas, getMe } from '../../../lib/api-server';

// Arena mode: the arena sidebar (your arenas from GET /v1/arenas) and the create-arena dialog, which
// both the sidebar and the empty home open.
export default async function ArenaLayout({ children }: { children: ReactNode }) {
  const [me, arenas] = await Promise.all([getMe(), getArenas()]);
  return (
    <CreateArenaProvider>
      <ArenaSidebar
        arenas={arenas.items}
        user={{ display_name: me?.display_name ?? '', email: me?.email ?? '' }}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </CreateArenaProvider>
  );
}
