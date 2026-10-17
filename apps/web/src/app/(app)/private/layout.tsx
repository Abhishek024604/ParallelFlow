import { type ReactNode, Suspense } from 'react';
import { PrivateSidebar } from '../../../components/private-sidebar';
import { SidebarSkeleton } from '../../../components/skeletons';
import { getPrivateChats, getPrivateProjects } from '../../../lib/api-server';

// Private mode (screens 01, 02): the sidebar with your chats and projects (build step 5), then the
// page. Everything here belongs to you alone (ADR-034). The sidebar streams in (Suspense), so the
// page never waits for the chat list.
export default function PrivateLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <Suspense fallback={<SidebarSkeleton label="Private" />}>
        <Sidebar />
      </Suspense>
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </>
  );
}

async function Sidebar() {
  const [chats, projects] = await Promise.all([getPrivateChats(), getPrivateProjects()]);
  return <PrivateSidebar chats={chats.items} projects={projects.items} />;
}
