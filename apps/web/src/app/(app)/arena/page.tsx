import { redirect } from 'next/navigation';
import { firstName, Illustration } from '../../../components/brand';
import { CreateArenaButton } from '../../../components/create-arena';
import { PlusIcon } from '../../../components/icons';
import { getArenas, getMe } from '../../../lib/api-server';

export const metadata = { title: 'Arena · Saras' };

// Arena mode home: your most recent arena, or the empty home (screen 18) when you have none.
export default async function ArenaHome() {
  const [me, arenas] = await Promise.all([getMe(), getArenas()]);
  const first = arenas.items[0];
  if (first) redirect(`/arena/${first.id}`);

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-8 py-12 text-center">
      <Illustration width={150} />
      <h1 className="mt-8 text-[30px] font-bold text-text">
        Welcome{me ? `, ${firstName(me.display_name)}` : ''}
      </h1>
      <p className="mt-4 max-w-[420px] text-[15px] text-muted">
        An arena is where your team and AI work on one project together. Create one and invite your
        teammates by email.
      </p>
      <CreateArenaButton className="btn cta mt-7 h-11 gap-2 px-4 text-[15px]">
        <PlusIcon size={16} />
        Create arena
      </CreateArenaButton>
      <p className="mt-7 text-[13px] text-faint">
        Invited by someone? Open the invitation link you were sent to join their arena.
      </p>
    </div>
  );
}
