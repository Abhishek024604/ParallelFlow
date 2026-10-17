import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeftIcon } from '../../../../../components/icons';
import { RolesSettings } from '../../../../../components/roles-settings';
import { getArena, getMembers, getRoles, getRoleTemplates } from '../../../../../lib/api-server';

// Arena settings → Roles (screen 07, build step 8). Optional: reached from the arena header. Roles
// are the only settings section in the MVP, so there is no settings menu yet.

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
      <RolesSettings
        projectId={arenaId}
        initialRoles={roles}
        initialMembers={members.items}
        templates={templates.items}
      />
    </div>
  );
}
