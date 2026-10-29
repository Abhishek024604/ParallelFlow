'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { signOut } from '../lib/api-browser';
import {
  type DragKind,
  DROP_OVER,
  requestCopyToChat,
  requestPush,
  useDropTarget,
} from '../lib/file-drag';
import { applyTheme, readTheme, type Theme } from '../lib/theme';
import { Avatar, Logo } from './brand';
import { CodeIcon, LockIcon, SignOutIcon, UsersIcon } from './icons';
import { BridgeHost } from './bridge-host';
import { InboxBell } from './inbox-bell';

// The global top bar (CLAUDE.md MVP scope): logo left, Private / Arena switch centre, inbox bell
// and avatar right. Rendered once by the signed-in app layout. Developer mode is hidden for now.

export interface TopBarUser {
  display_name: string;
  email: string;
}

/**
 * A mode link that is also a drop target (ADR-041): an arena file dropped on Private opens "Copy to
 * my chat"; a private file dropped on Arena opens Push to Arena. Both still ask before anything
 * crosses.
 */
function ModeLink({
  href,
  active,
  icon,
  accepts,
  children,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  accepts: DragKind;
  children: ReactNode;
}) {
  const drop = useDropTarget([accepts], (payload) => {
    if (payload.kind === 'arena') {
      requestCopyToChat({ projectId: payload.project_id, artifactIds: [payload.artifact_id] });
    } else if (payload.kind === 'private') {
      requestPush({ artifactId: payload.artifact_id });
    }
  });
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      {...drop.props}
      className={`mode inline-flex h-8 items-center gap-2 px-4 text-[14px] no-underline ${
        active ? 'on font-medium text-text' : 'text-muted hover:text-text'
      } ${drop.over ? DROP_OVER : ''}`}
    >
      {icon}
      {children}
    </Link>
  );
}

const THEME_LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** System / Light / Dark (lib/theme.ts): saved in a cookie, applied to <html> at once. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => setTheme(readTheme()), []);
  return (
    <div role="group" aria-label="Theme" className="px-3 py-2">
      <div className="mb-1.5 text-[12px] text-faint">Theme</div>
      <div className="flex gap-1 rounded-lg border border-line bg-raise p-0.5">
        {(Object.keys(THEME_LABEL) as Theme[]).map((t) => (
          <button
            key={t}
            type="button"
            role="menuitemradio"
            aria-checked={theme === t}
            onClick={() => {
              applyTheme(t);
              setTheme(t);
            }}
            className={`h-7 flex-1 rounded-md text-[13px] ${
              theme === t
                ? 'bg-panel font-medium text-text shadow-card'
                : 'text-muted hover:text-text'
            }`}
          >
            {THEME_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

function AvatarMenu({ user }: { user: TopBarUser }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.display_name}`}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full"
      >
        <Avatar name={user.display_name} size={34} />
      </button>
      {open && (
        <div role="menu" className="card rise absolute right-0 top-11 z-40 w-64 p-1.5 shadow-pop">
          <div className="px-3 py-2">
            <div className="truncate font-semibold text-text">{user.display_name}</div>
            <div className="truncate text-[12px] text-faint">{user.email}</div>
          </div>
          <div className="my-1 h-px bg-line" />
          <ThemeSwitch />
          <div className="my-1 h-px bg-line" />
          <Link
            href="/device"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="nav flex w-full items-center gap-2 px-3 py-2 text-left text-text no-underline"
          >
            <CodeIcon size={15} />
            Connected apps
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => void signOut()}
            className="nav flex w-full items-center gap-2 px-3 py-2 text-left text-text"
          >
            <SignOutIcon />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar({ user }: { user: TopBarUser }) {
  const pathname = usePathname();
  const mode = pathname.startsWith('/private') ? 'private' : 'arena';
  return (
    <header className="relative z-20 flex h-[43px] shrink-0 items-center border-b border-line bg-bg px-4">
      <Link href="/arena" className="no-underline" aria-label="ParallelFlow home">
        <Logo size={32} />
      </Link>
      <nav
        aria-label="Space"
        className="modes absolute left-1/2 top-[2px] flex -translate-x-1/2 items-center gap-0.5 p-[3px]"
      >
        <ModeLink
          href="/private"
          active={mode === 'private'}
          icon={<LockIcon size={15} />}
          accepts="arena"
        >
          Private
        </ModeLink>
        <ModeLink
          href="/arena"
          active={mode === 'arena'}
          icon={<UsersIcon size={15} />}
          accepts="private"
        >
          Arena
        </ModeLink>
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <InboxBell />
        <AvatarMenu user={user} />
      </div>
      <BridgeHost />
    </header>
  );
}
