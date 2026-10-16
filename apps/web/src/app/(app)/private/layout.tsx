import type { ReactNode } from 'react';
import { FileIcon, PencilIcon, PlusIcon, SearchIcon } from '../../../components/icons';
import { SoonButton } from '../../../components/soon';

// Private sidebar (screen 01, CLAUDE.md: works like ChatGPT projects). Private chats, files and
// projects arrive in build step 5, so every list shows its real, empty state and the actions are
// disabled with a "Coming soon" hint (SLICE_DEBT).

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="label px-3">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export default function PrivateLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <aside
        aria-label="Private"
        className="flex w-[270px] shrink-0 flex-col border-r border-line bg-side px-3 pb-3 pt-3.5"
      >
        <SoonButton className="card flex h-11 w-full items-center gap-3 px-3 text-left text-[15px] font-medium text-text shadow-card">
          <PencilIcon />
          New chat
          <span className="kbd chip ml-auto px-1.5 text-[11px] leading-5 text-faint">Ctrl N</span>
        </SoonButton>
        <div className="mt-2 space-y-0.5">
          <SoonButton className="nav flex h-9 w-full items-center gap-3 px-3 text-left text-[15px] text-text">
            <SearchIcon />
            Search chats
          </SoonButton>
          <SoonButton className="nav flex h-9 w-full items-center gap-3 px-3 text-left text-[15px] text-text">
            <FileIcon />
            My files
          </SoonButton>
        </div>

        <Section title="Projects">
          <SoonButton className="nav flex h-9 w-full items-center gap-3 px-3 text-left text-[14px] text-muted">
            <PlusIcon />
            New project
          </SoonButton>
          <p className="px-3 py-1.5 text-[13px] text-faint">No projects yet</p>
        </Section>

        <Section title="Recent chats">
          <p className="px-3 py-1.5 text-[13px] text-faint">No chats yet</p>
        </Section>

        <p className="mt-auto border-t border-line px-3 pt-3 text-[12px] text-faint">
          Private chats are visible only to you.
        </p>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </>
  );
}
