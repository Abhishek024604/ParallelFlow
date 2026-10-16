import type { ReactNode } from 'react';
import { PrivateSidebar } from '../../../components/private-sidebar';
import { getPrivateChats, getPrivateProjects } from '../../../lib/api-server';

// Private mode (screens 01, 02): the sidebar with your chats and projects (build step 5), then the
// page. Everything here belongs to you alone (ADR-034).
export default async function PrivateLayout({ children }: { children: ReactNode }) {
  const [chats, projects] = await Promise.all([getPrivateChats(), getPrivateProjects()]);
  return (
    <>
      <PrivateSidebar chats={chats.items} projects={projects.items} />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </>
  );
}
