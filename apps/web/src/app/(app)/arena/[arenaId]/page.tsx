import type { ArenaInvite } from '@saras/contracts';
import { notFound } from 'next/navigation';
import { ArenaKey, cycleLabel } from '../../../../components/arena-bits';
import { getArena } from '../../../../lib/api-server';

// One arena. The full arena (stream, loop, tasks, members) is build step 3; for now this shows what
// exists: the name, members, the current cycle and, for the owner, the invites sent.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS: Record<ArenaInvite['status'], { label: string; chip: string }> = {
  pending: { label: 'Waiting to join', chip: 'chip warn' },
  accepted: { label: 'Joined', chip: 'chip ok' },
  revoked: { label: 'Revoked', chip: 'chip' },
  expired: { label: 'Expired', chip: 'chip' },
};

function expiresIn(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return days <= 1 ? 'expires within a day' : `expires in ${days} days`;
}

export default async function ArenaPage({ params }: { params: Promise<{ arenaId: string }> }) {
  const { arenaId } = await params;
  if (!UUID.test(arenaId)) notFound();
  const arena = await getArena(arenaId);
  if (!arena) notFound();
  const cycle = cycleLabel(arena);

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line px-6 py-4">
        <ArenaKey arenaKey={arena.key} size="md" />
        <div className="min-w-0">
          <h1 className="truncate text-[18px] font-bold text-text">{arena.name}</h1>
          <p className="text-[13px] text-faint">
            {arena.member_count} {arena.member_count === 1 ? 'member' : 'members'} · AI included
          </p>
        </div>
        {cycle && <span className="chip acc ml-auto px-2.5 py-1 text-[12px]">{cycle}</span>}
      </header>

      <div className="mx-auto w-full max-w-[720px] px-6 py-8">
        {arena.description && <p className="text-[15px] text-muted">{arena.description}</p>}

        {arena.role === 'owner' && (
          <section className="mt-8">
            <h2 className="label">Invites</h2>
            {arena.invites.length === 0 ? (
              <p className="mt-3 text-[13px] text-faint">
                No invites yet. Inviting from the arena comes with the members page.
              </p>
            ) : (
              <>
                <ul className="card mt-3 divide-y divide-line">
                  {arena.invites.map((invite) => {
                    const status = STATUS[invite.status];
                    return (
                      <li key={invite.id} className="flex items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium text-text">{invite.email}</div>
                          {invite.status === 'pending' && (
                            <div className="text-[12px] text-faint">
                              Link {expiresIn(invite.expires_at)}
                            </div>
                          )}
                        </div>
                        <span className={`${status.chip} px-2 py-0.5 text-[12px]`}>
                          {status.label}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="mt-3 text-[12px] text-faint">
                  Invite links are shown once, when you create the arena.
                </p>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
