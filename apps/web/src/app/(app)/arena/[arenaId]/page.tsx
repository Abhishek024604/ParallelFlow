import type { ArenaDetail, ProjectMember } from '@saras/contracts';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArenaKey } from '../../../../components/arena-bits';
import { ArenaPanel } from '../../../../components/arena-panel';
import { ArenaRepoPanel } from '../../../../components/arena-repo';
import { ArenaRoom } from '../../../../components/arena-room';
import { SettingsIcon } from '../../../../components/icons';
import { InvitePanel } from '../../../../components/invite-panel';
import { LoopProvider, StageStrip } from '../../../../components/loop';
import { getArena, getArenaMessages, getLoopState, getMembers } from '../../../../lib/api-server';

// One arena (screen 04, build step 3): header, the stage strip with its gate (step 7), the message
// stream with its composer and gate cards, and the right panel. The server renders the latest
// messages and the loop state; the client polls for newer ones.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ArenaPage({ params }: { params: Promise<{ arenaId: string }> }) {
  const { arenaId: rawId } = await params;
  if (!UUID.test(rawId)) notFound();
  const arenaId = rawId.toLowerCase();
  const [arena, members, messages, loop] = await Promise.all([
    getArena(arenaId),
    getMembers(arenaId),
    getArenaMessages(arenaId),
    getLoopState(arenaId),
  ]);
  if (!arena || !members || !messages || !loop) notFound();

  return (
    <div className="flex h-full min-h-0">
      <LoopProvider projectId={arenaId} initial={loop}>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-4 border-b border-line px-6 py-4">
            <ArenaKey arenaKey={arena.key} size="md" />
            <div className="min-w-0">
              <h1 className="truncate text-[18px] font-bold text-text">{arena.name}</h1>
              <p className="text-[13px] text-faint">
                {arena.member_count} {arena.member_count === 1 ? 'member' : 'members'} · AI is here
                to help
              </p>
            </div>
            <Link
              href={`/arena/${arenaId}/settings`}
              className="btn ghost ml-auto h-10 gap-2 px-3 text-[14px]"
            >
              <SettingsIcon />
              Settings
            </Link>
          </header>
          <StageStrip />
          <ArenaRoom
            arenaId={arenaId}
            arenaKey={arena.key}
            initial={messages}
            canPost={members.viewer.can_post}
            viewerId={members.viewer.user_id}
            memberNames={members.items.map((m) => m.display_name)}
          />
        </div>
      </LoopProvider>
      <ArenaPanel
        projectId={arenaId}
        overview={<Overview arena={arena} projectId={arenaId} />}
        members={
          <>
            <InvitePanel projectId={arenaId} arena={arena} />
            <Members members={members.items} />
          </>
        }
      />
    </div>
  );
}

function Overview({ arena, projectId }: { arena: ArenaDetail; projectId: string }) {
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
      <ArenaRepoPanel projectId={projectId} />
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
