import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArenaGeneralSettings } from '../../../../../components/arena-general-settings';
import { ChevronLeftIcon } from '../../../../../components/icons';
import { RolesSettings } from '../../../../../components/roles-settings';
import { getArena, getMembers, getRoles, getRoleTemplates } from '../../../../../lib/api-server';

// Arena settings (reached from the arena header): the arena's name, archive and delete for the owner
// (ADR-038), then Roles (screen 07, build step 8).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ArenaSettingsPage({
  params,
}: {
  params: Promise<{ arenaId: string }>;
}) {
  const { arenaId: rawId } = await params;
  if (!UUID.test(rawId)) notFound();
  const arenaId = rawId.toLowerCase();
  const [arena, roles, members, templates] = await Promise.all([
    getArena(arenaId),
    getRoles(arenaId),
    getMembers(arenaId),
    getRoleTemplates(),
  ]);
  if (!arena || !roles || !members) notFound();

  return (
    <div className="min-h-full">
      <div className="border-b border-line px-6 py-3">
        <Link
          href={`/arena/${arenaId}`}
          className="inline-flex items-center gap-1.5 text-[14px] text-muted hover:text-text"
        >
          <ChevronLeftIcon />
          Back to {arena.name}
        </Link>
      </div>
      {arena.role === 'owner' && <ArenaGeneralSettings arena={arena} />}
      <RolesSettings
        projectId={arenaId}
        initialRoles={roles}
        initialMembers={members.items}
        templates={templates.items}
      />
    </div>
  );
}
