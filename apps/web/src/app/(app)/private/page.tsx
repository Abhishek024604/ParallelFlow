import { LogoMark } from '../../../components/brand';
import { HandoffCard } from '../../../components/bridge-host';
import { PrivateHomeComposer } from '../../../components/private-home-composer';
import { PrivateSuggestions } from '../../../components/private-suggestions';
import { getPrivateProjects, installedExtensions } from '../../../lib/api-server';

export const metadata = { title: 'Private · ParallelFlow' };

// Private home (screen 01). Writing here starts a new private chat with your AI (build step 5); a
// chat is only created when its first message is sent. `?project=<id>` ("New chat" in a project)
// starts it in that project. "Bring context from an Arena" starts a chat and opens the arena
// picker (step 6).
export default async function PrivateHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { project: projectId, handoff, arena } = await searchParams;
  // The stage handoff from the Inbox (ADR-041): ?handoff=<approval>&arena=<project>.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const handoffFor =
    typeof handoff === 'string' &&
    typeof arena === 'string' &&
    uuid.test(handoff) &&
    uuid.test(arena)
      ? { approvalId: handoff, projectId: arena }
      : null;
  const [project, extensions] = await Promise.all([
    typeof projectId === 'string'
      ? getPrivateProjects().then((list) => list.items.find((p) => p.id === projectId))
      : undefined,
    installedExtensions(),
  ]);
  return (
    <div className="mx-auto flex min-h-full max-w-[1000px] flex-col items-center justify-center px-8 py-12">
      <LogoMark size={72} />
      <h1 className="mt-6 text-[56px] font-bold leading-none tracking-[-0.025em] text-text">
        ParallelFlow
      </h1>
      <p className="mt-5 text-[26px] text-muted">Let&rsquo;s build and ship.</p>

      {handoffFor && (
        <div className="mt-8 w-full">
          <HandoffCard projectId={handoffFor.projectId} approvalId={handoffFor.approvalId} />
        </div>
      )}
      <div className="mt-10 w-full">
        <PrivateHomeComposer
          key={project?.id ?? 'none'}
          extensions={extensions}
          {...(project && { project: { id: project.id, name: project.name } })}
        />
      </div>
      <PrivateSuggestions />
      <p className="mt-4 text-center text-[13px] text-faint">
        Private chats are visible only to you. Share a file with your team using Push to Arena.
      </p>
    </div>
  );
}
