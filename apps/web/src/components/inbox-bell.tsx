'use client';

import type { InboxNotification, NotificationPage } from '@parallelflow/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchNotifications,
  markAllRead,
  markRead,
  NOTIFICATIONS_CHANGED_EVENT,
  NOTIFICATIONS_PAGE_EVENT,
  notificationTime,
  safeDeepLink,
  typeLabel,
} from '../lib/notifications';
import { BellIcon } from './icons';

// The top bar's Inbox bell: the unread count (polled every 15 s while the tab is visible) and a
// dropdown of the latest items. Opening one marks it read and follows its link.

const POLL_MS = 15_000;

export function InboxBell() {
  const router = useRouter();
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const next = await fetchNotifications('all', { limit: 8 });
      setPage(next);
      window.dispatchEvent(new CustomEvent(NOTIFICATIONS_PAGE_EVENT, { detail: next }));
    } catch {
      // Keep the last count; the next poll tries again.
    }
  }, []);

  useEffect(() => {
    void load();
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = setInterval(tick, POLL_MS);
    const onChanged = () => void load();
    document.addEventListener('visibilitychange', tick);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, onChanged);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    void load();
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, load]);

  const unread = page?.unread_count ?? 0;

  async function openItem(item: InboxNotification) {
    setOpen(false);
    if (!item.read_at) {
      try {
        await markRead(item.id);
      } catch {
        // Following the link still works.
      }
    }
    router.push(safeDeepLink(item.deep_link));
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={unread ? `Inbox, ${unread} unread` : 'Inbox'}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:text-text"
      >
        <BellIcon size={17} />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="chip acc absolute -right-1.5 -top-1 min-w-[18px] px-1 text-center text-[10px] font-semibold leading-4"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="card rise absolute right-0 top-11 z-40 w-[360px] shadow-pop"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <span className="font-semibold text-text">Inbox</span>
            {unread > 0 && (
              <button
                type="button"
                className="text-[13px] text-muted hover:text-text"
                onClick={() => void markAllRead()}
              >
                Mark all as read
              </button>
            )}
          </div>
          {!page ? (
            <p className="px-4 py-6 text-center text-[13px] text-faint">Loading…</p>
          ) : page.items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-faint">
              Nothing yet. Approvals, mentions and pushes show up here.
            </p>
          ) : (
            <ul className="max-h-[420px] overflow-y-auto py-1">
              {page.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void openItem(item)}
                    className={`nav flex w-full items-start gap-3 px-4 py-2.5 text-left ${
                      item.requires_action && !item.resolved_at ? 'bg-acc-soft' : ''
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        item.read_at ? 'bg-transparent' : 'bg-acc'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-[14px] ${
                          item.read_at ? 'text-muted' : 'font-semibold text-text'
                        }`}
                      >
                        {item.title}
                      </span>
                      <span className="block truncate text-[12px] text-faint">
                        {item.arena_name}
                        {item.preview ? ` · ${item.preview}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-[11px] text-faint">
                      {notificationTime(item.created_at)}
                      <span className="mt-1 block">{typeLabel(item)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-line px-4 py-2 text-center">
            <Link
              href="/inbox"
              onClick={() => setOpen(false)}
              className="text-[13px] text-muted no-underline hover:text-text"
            >
              Open Inbox
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
