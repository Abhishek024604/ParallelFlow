'use client';

import { type ReactNode, useState } from 'react';
import { SoonTip } from './soon';

// The arena's right panel (screen 04): Overview and Members now; Tasks and Artifacts arrive with
// later build steps and are shown disabled. The tab contents are rendered by the server page.

type Tab = 'overview' | 'members';

const TABS: { id: Tab | 'tasks' | 'artifacts'; label: string; soon?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks', soon: true },
  { id: 'artifacts', label: 'Artifacts', soon: true },
  { id: 'members', label: 'Members' },
];

export function ArenaPanel({ overview, members }: { overview: ReactNode; members: ReactNode }) {
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
        {tab === 'overview' ? overview : members}
      </div>
    </aside>
  );
}
