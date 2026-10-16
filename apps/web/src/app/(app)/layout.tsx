import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { TopBar } from '../../components/top-bar';
import { getMe } from '../../lib/api-server';

// The signed-in app shell: the global top bar, built once for every signed-in page. Each mode
// (private/, arena/) adds its own sidebar. The middleware already sent signed-out visitors to
// /sign-in with their path; this check covers a session that ended in between.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/sign-in');
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <TopBar user={{ display_name: me.display_name, email: me.email }} />
      <div className="flex min-h-0 flex-1">{children}</div>
    </div>
  );
}
