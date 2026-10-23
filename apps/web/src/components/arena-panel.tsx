'use client';

import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  clampPanelWidth,
  isPanelWide,
  panelMaxWidth,
  panelWideWidth,
} from '../lib/panel-width';
import { ArenaArtifactsList } from './artifact-viewer';
import { CollapseIcon, ExpandIcon } from './icons';
import { SoonTip } from './soon';

// The arena's right panel (screen 04): Overview, Approved (approved documents; drafts are under
// Files in the left sidebar) and
// Members; Tasks arrive with a later build step and are shown disabled. Overview and Members are
// rendered by the server page; Artifacts loads on the client.
// The panel can be resized with its left edge (drag, or arrow keys on the handle) and toggled to a
// wide mode (half the window). The width is remembered per browser.

type Tab = 'overview' | 'artifacts' | 'members';

const TABS: { id: Tab | 'tasks'; label: string; soon?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'tasks', label: 'Tasks', soon: true },
  { id: 'artifacts', label: 'Approved' },
  { id: 'members', label: 'Members' },
];

const STORAGE_KEY = 'parallelflow.arenaPanel.width';
const KEY_STEP = 24;
const DEFAULT_WIDTH = PANEL_DEFAULT_WIDTH;
const MIN_WIDTH = PANEL_MIN_WIDTH;

function viewport(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

const maxWidth = () => panelMaxWidth(viewport());
const wideWidth = () => panelWideWidth(viewport());
const clamp = (width: number) => clampPanelWidth(width, viewport());

function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function storeWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    // Storage may be blocked; the width just isn't remembered.
  }
}

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
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const narrowWidth = useRef(DEFAULT_WIDTH);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const stored = readStoredWidth();
    if (stored) setWidth(clamp(stored));
  }, []);

  const apply = useCallback((next: number) => {
    const value = clamp(next);
    setWidth(value);
    storeWidth(value);
  }, []);

  const wide = isPanelWide(width, viewport());

  function toggleWide() {
    if (wide) {
      apply(isPanelWide(narrowWidth.current, viewport()) ? DEFAULT_WIDTH : narrowWidth.current);
    } else {
      narrowWidth.current = width;
      apply(wideWidth());
    }
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    // The handle is on the left edge, so moving left widens the panel.
    setWidth(clamp(drag.current.startWidth + (drag.current.startX - event.clientX)));
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start) return;
    drag.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture already released.
    }
    apply(start.startWidth + (start.startX - event.clientX));
  }

  function onHandleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft') apply(width + KEY_STEP);
    else if (event.key === 'ArrowRight') apply(width - KEY_STEP);
    else if (event.key === 'Home') apply(MIN_WIDTH);
    else if (event.key === 'End') apply(maxWidth());
    else return;
    event.preventDefault();
  }

  return (
    <aside
      aria-label="Arena details"
      style={{ width }}
      className="relative hidden shrink-0 flex-col border-l border-line lg:flex"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize arena details"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth()}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setDragging(false);
          storeWidth(width);
        }}
        onKeyDown={onHandleKey}
        onDoubleClick={toggleWide}
        className={`absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none ${
          dragging ? 'bg-line2' : 'hover:bg-line focus-visible:bg-line'
        }`}
      />
      <div className="flex items-center border-b border-line pl-4 pr-2">
        <div role="tablist" aria-label="Arena details" className="flex min-w-0 flex-1 gap-1">
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
        <button
          type="button"
          onClick={toggleWide}
          aria-pressed={wide}
          aria-label={wide ? 'Collapse arena details' : 'Expand arena details'}
          title={wide ? 'Collapse' : 'Expand'}
          className="nav inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted hover:text-text"
        >
          {wide ? <CollapseIcon /> : <ExpandIcon />}
        </button>
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
