import { LogoMark } from '../../../components/brand';
import { PrivateHomeComposer } from '../../../components/private-home-composer';
import { PrivateSuggestions } from '../../../components/private-suggestions';
import { getPrivateProjects } from '../../../lib/api-server';

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
  const { project: projectId } = await searchParams;
  const project =
    typeof projectId === 'string'
      ? (await getPrivateProjects()).items.find((p) => p.id === projectId)
      : undefined;
  return (
    <div className="mx-auto flex min-h-full max-w-[1000px] flex-col items-center justify-center px-8 py-12">
      <LogoMark size={72} />
      <h1 className="mt-6 text-[56px] font-bold leading-none tracking-[-0.025em] text-text">
        ParallelFlow
      </h1>
      <p className="mt-5 text-[26px] text-muted">Let&rsquo;s build and ship.</p>

      <div className="mt-10 w-full">
        <PrivateHomeComposer
          key={project?.id ?? 'none'}
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
