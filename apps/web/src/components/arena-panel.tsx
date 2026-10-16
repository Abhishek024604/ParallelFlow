'use client';

import { type ReactNode, useState } from 'react';
import { ArenaArtifactsList } from './artifact-viewer';
import { SoonTip } from './soon';

// The arena's right panel (screen 04): Overview, Artifacts (step 6: list, opens the viewer) and
// Members; Tasks arrive with a later build step and are shown disabled. Overview and Members are
// rendered by the server page; Artifacts loads on the client.

type Tab = 'overview' | 'artifacts' | 'members';

const TABS: { id: Tab | 'tasks'; label: string; soon?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks', soon: true },
  { id: 'artifacts', label: 'Artifacts' },
  { id: 'members', label: 'Members' },
];

export function ArenaPanel({
  projectId,
  overview,
  members,
}: {
  projectId: string;
  overview: ReactNode;
  members: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <aside
      aria-label="Arena details"
      className="hidden w-[340px] shrink-0 flex-col border-l border-line lg:flex"
    >
      <div
        role="tablist"
        aria-label="Arena details"
        className="flex gap-1 border-b border-line px-4"
      >
        {TABS.map((t) =>
          t.soon ? (
            <span key={t.id} className="w-auto">
              <SoonTip side="bottom">
                <button
                  type="button"
                  role="tab"
                  aria-selected="false"
                  aria-disabled="true"
                  className="cursor-not-allowed px-2.5 py-3 text-[14px] text-faint opacity-70"
                >
                  {t.label}
                </button>
              </SoonTip>
            </span>
          ) : (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`arena-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`arena-panel-${t.id}`}
              onClick={() => setTab(t.id as Tab)}
              className={`-mb-px border-b-2 px-2.5 py-3 text-[14px] ${
                tab === t.id
                  ? 'border-text font-semibold text-text'
                  : 'border-transparent text-muted hover:text-text'
              }`}
            >
              {t.label}
            </button>
          ),
        )}
      </div>
      <div
        role="tabpanel"
        id={`arena-panel-${tab}`}
        aria-labelledby={`arena-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
      >
        {tab === 'overview' ? (
          overview
        ) : tab === 'artifacts' ? (
          <ArenaArtifactsList projectId={projectId} />
        ) : (
          members
        )}
      </div>
    </aside>
  );
}
