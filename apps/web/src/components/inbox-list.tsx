'use client';

import type { InboxNotification, NotificationFilter, NotificationPage } from '@saras/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ProblemError } from '../lib/api-browser';
import {
  fetchNotifications,
  markAllRead,
  markRead,
  NOTIFICATIONS_CHANGED_EVENT,
  notificationTime,
  safeDeepLink,
  TYPE_LABELS,
} from '../lib/notifications';
import { ChevronLeftIcon, FlagIcon, InboxIcon } from './icons';

// The Inbox page (screen 10, without DMs): filters on the left (All / Needs action / Unread), the
// list in the middle, newest first, with items that need your action on top under "All".

const FILTERS: { id: NotificationFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'action', label: 'Needs action' },
  { id: 'unread', label: 'Unread' },
];

export function InboxList() {
  const router = useRouter();
  const [filter, setFilter] = useState<NotificationFilter>('all');
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [more, setMore] = useState<InboxNotification[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await fetchNotifications(filter, { limit: 30 });
      setPage(next);
      setMore([]);
      setCursor(next.next_cursor);
      setError(null);
    } catch (err) {
      setError(err instanceof ProblemError ? err.detail : 'Could not load your Inbox.');
    }
  }, [filter]);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const next = await fetchNotifications(filter, { limit: 30, cursor });
      setMore((items) => [...items, ...next.items]);
      setCursor(next.next_cursor);
    } catch {
      setError('Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }

  async function open(item: InboxNotification) {
    if (!item.read_at) {
      try {
        await markRead(item.id);
      } catch {
        // Following the link still works.
      }
    }
    router.push(safeDeepLink(item.deep_link));
  }

  const items = [...(page?.items ?? []), ...more];
  const action = filter === 'all' ? items.filter((n) => n.requires_action && !n.resolved_at) : [];
  const rest = filter === 'all' ? items.filter((n) => !action.includes(n)) : items;
  const counts: Record<NotificationFilter, number | null> = {
    all: null,
    action: page?.action_count ?? null,
    unread: page?.unread_count ?? null,
  };

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        aria-label="Inbox filters"
        className="flex w-[260px] shrink-0 flex-col border-r border-line bg-side px-3 pb-3 pt-4"
      >
        <Link
          href="/arena"
          className="nav flex h-9 items-center gap-2 px-3 text-[14px] text-muted no-underline"
        >
          <ChevronLeftIcon />
          Back to Arena
        </Link>
        <h1 className="mt-4 px-3 text-[22px] font-bold text-text">Inbox</h1>
        <nav aria-label="Filters" className="mt-4 space-y-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`nav flex h-10 w-full items-center gap-3 px-3 text-left text-[15px] text-text ${
                filter === f.id ? 'bg-panel shadow-card' : ''
              }`}
            >
              {f.id === 'action' ? <FlagIcon /> : <InboxIcon />}
              <span className="flex-1">{f.label}</span>
              {counts[f.id] ? <span className="text-[12px] text-faint">{counts[f.id]}</span> : null}
            </button>
          ))}
        </nav>
      </aside>

      <section aria-label="Notifications" className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-4 border-b border-line px-6 py-4">
          <h2 className="text-[17px] font-semibold text-text">
            {FILTERS.find((f) => f.id === filter)?.label} notifications
          </h2>
          {(page?.unread_count ?? 0) > 0 && (
            <button
              type="button"
              className="btn ghost ml-auto h-9 px-3 text-[14px]"
              onClick={() => void markAllRead()}
            >
              Mark all as read
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && (
            <p role="alert" className="px-6 py-3 text-[13px] text-bad">
              {error}
            </p>
          )}
          {!page ? (
            <p className="px-6 py-8 text-[14px] text-faint">Loading…</p>
          ) : items.length === 0 ? (
            <p className="px-6 py-8 text-[14px] text-faint">
              {filter === 'all'
                ? 'Nothing yet. Gate approvals, mentions, pushes and new teammates show up here.'
                : filter === 'action'
                  ? 'Nothing needs your action.'
                  : 'You are all caught up.'}
            </p>
          ) : (
            <>
              {action.length > 0 && (
                <Group label="Needs your action" items={action} onOpen={open} />
              )}
              {rest.length > 0 && (
                <Group label={filter === 'all' ? 'Recent' : null} items={rest} onOpen={open} />
              )}
              {cursor && (
                <div className="flex justify-center py-4">
                  <button
                    type="button"
                    className="btn ghost h-9 px-3 text-[14px]"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Group({
  label,
  items,
  onOpen,
}: {
  label: string | null;
  items: InboxNotification[];
  onOpen: (item: InboxNotification) => Promise<void>;
}) {
  return (
    <section>
      {label && <h3 className="label px-6 pb-2 pt-5">{label}</h3>}
      <ul>
        {items.map((item) => {
          const needsAction = item.requires_action && !item.resolved_at;
          return (
            <li key={item.id} className="border-b border-line">
              <button
                type="button"
                onClick={() => void onOpen(item)}
                className={`flex w-full items-start gap-4 px-6 py-3.5 text-left hover:bg-raise ${
                  needsAction ? 'bg-acc-soft' : ''
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-2 h-2 w-2 shrink-0 rounded-full ${
                    item.read_at ? 'bg-transparent' : 'bg-acc'
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-[15px] ${
                      item.read_at ? 'text-muted' : 'font-semibold text-text'
                    }`}
                  >
                    {item.title}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-faint">
                    {item.arena_name}
                    {item.preview ? ` · ${item.preview}` : ''}
                  </span>
                  {!item.read_at && <span className="sr-only">Unread</span>}
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1.5">
                  <span className="text-[12px] text-faint">
                    {notificationTime(item.created_at)}
                  </span>
                  <span className={`chip px-2 py-0.5 text-[12px] ${needsAction ? 'acc' : ''}`}>
                    {TYPE_LABELS[item.type]}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
