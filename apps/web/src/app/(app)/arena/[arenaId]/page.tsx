import {
  type ArenaDetail,
  type ArenaInvite,
  type ProjectMember,
  SDLC_STAGES,
} from '@saras/contracts';
import { notFound } from 'next/navigation';
import { ArenaKey } from '../../../../components/arena-bits';
import { ArenaPanel } from '../../../../components/arena-panel';
import { ArenaRoom } from '../../../../components/arena-room';
import { LockIcon } from '../../../../components/icons';
import { SoonTip } from '../../../../components/soon';
import { getArena, getArenaMessages, getMembers } from '../../../../lib/api-server';

// One arena (screen 04, build step 3): header, the current cycle and stage (read-only text; gates
// and stage moves are step 7), the message stream with its composer, and the right panel. The
// server renders the latest messages; the client polls for newer ones.

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
  const { arenaId: rawId } = await params;
  if (!UUID.test(rawId)) notFound();
  const arenaId = rawId.toLowerCase();
  const [arena, members, messages] = await Promise.all([
    getArena(arenaId),
    getMembers(arenaId),
    getArenaMessages(arenaId),
  ]);
  if (!arena || !members || !messages) notFound();

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-line px-6 py-4">
          <ArenaKey arenaKey={arena.key} size="md" />
          <div className="min-w-0">
            <h1 className="truncate text-[18px] font-bold text-text">{arena.name}</h1>
            <p className="text-[13px] text-faint">
              {arena.member_count} {arena.member_count === 1 ? 'member' : 'members'} · AI is here to
              help
            </p>
          </div>
          <span className="ml-auto w-auto">
            <SoonTip side="bottom">
              <button
                type="button"
                aria-disabled="true"
                className="btn h-10 cursor-not-allowed gap-2 px-4 opacity-55"
              >
                <LockIcon />
                Private
              </button>
            </SoonTip>
          </span>
        </header>
        <StageStrip arena={arena} />
        <ArenaRoom
          arenaId={arenaId}
          arenaKey={arena.key}
          initial={messages}
          canPost={members.viewer.can_post}
          viewerId={members.viewer.user_id}
          memberNames={members.items.map((m) => m.display_name)}
        />
      </div>
      <ArenaPanel
        overview={<Overview arena={arena} />}
        members={<Members members={members.items} />}
      />
    </div>
  );
}

/** The current cycle and stage, as text. No gate states: those come with the loop (step 7). */
function StageStrip({ arena }: { arena: ArenaDetail }) {
  if (arena.cycle === null || arena.stage === null) return null;
  return (
    <div className="flex items-center gap-4 border-b border-line px-6 py-3">
      <span className="shrink-0 text-[14px] font-semibold text-text">Cycle {arena.cycle}</span>
      <ol aria-label="Stages" className="flex min-w-0 flex-1 gap-2 overflow-hidden">
        {SDLC_STAGES.map((stage) => {
          const current = stage === arena.stage;
          return (
            <li
              key={stage}
              aria-current={current ? 'step' : undefined}
              className={`min-w-0 flex-1 border-t-[3px] pt-1.5 text-[12px] ${
                current ? 'border-acc font-semibold text-acc-ink' : 'border-line text-faint'
              }`}
            >
              <span className="block truncate">{stage}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function Overview({ arena }: { arena: ArenaDetail }) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="label">Goal</h2>
        {arena.description ? (
          <p className="mt-2 whitespace-pre-wrap text-[14px] text-text">{arena.description}</p>
        ) : (
          <p className="mt-2 text-[13px] text-faint">
            No goal yet. The arena description shows here.
          </p>
        )}
      </section>

      {arena.role === 'owner' && (
        <section>
          <h2 className="label">Invites</h2>
          {arena.invites.length === 0 ? (
            <p className="mt-2 text-[13px] text-faint">
              No invites yet. Inviting from the arena comes with the members page.
            </p>
          ) : (
            <>
              <ul className="card mt-2 divide-y divide-line">
                {arena.invites.map((invite) => {
                  const status = STATUS[invite.status];
                  return (
                    <li key={invite.id} className="flex items-center gap-3 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-text">
                          {invite.email}
                        </div>
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
              <p className="mt-2 text-[12px] text-faint">
                Invite links are shown once, when you create the arena.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function Members({ members }: { members: ProjectMember[] }) {
  return (
    <section>
      <h2 className="label">Members &amp; roles</h2>
      <ul className="mt-3 space-y-3">
        {members.map((member) => (
          <li key={member.user_id} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="av inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px]"
            >
              {member.initials}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-text">
                {member.display_name}
              </div>
              <div className="truncate text-[12px] text-faint">{member.email}</div>
            </div>
            <span className="flex shrink-0 flex-wrap justify-end gap-1">
              {member.roles.map((role) => (
                <span key={role.id} className="chip px-2 py-0.5 text-[12px]">
                  {role.name}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
