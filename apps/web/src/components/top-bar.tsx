'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { signOut } from '../lib/api-browser';
import { Avatar, Logo } from './brand';
import { CodeIcon, LockIcon, SignOutIcon, UsersIcon } from './icons';
import { InboxBell } from './inbox-bell';

// The global top bar (CLAUDE.md MVP scope): logo left, Private / Arena / Developer switch centre,
// inbox bell and avatar right. Rendered once by the signed-in app layout.

export interface TopBarUser {
  display_name: string;
  email: string;
}

function ModeLink({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`mode inline-flex h-8 items-center gap-2 px-4 text-[14px] no-underline ${
        active ? 'on font-medium text-text' : 'text-muted hover:text-text'
      }`}
    >
      {icon}
      {children}
    </Link>
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
      <Link href="/arena" className="no-underline" aria-label="Saras home">
        <Logo size={32} />
      </Link>
      <nav
        aria-label="Space"
        className="modes absolute left-1/2 top-[2px] flex -translate-x-1/2 items-center gap-0.5 p-[3px]"
      >
        <ModeLink href="/private" active={mode === 'private'} icon={<LockIcon size={15} />}>
          Private
        </ModeLink>
        <ModeLink href="/arena" active={mode === 'arena'} icon={<UsersIcon size={15} />}>
          Arena
        </ModeLink>
        <span
          aria-disabled="true"
          className="mode inline-flex h-8 cursor-not-allowed items-center gap-2 px-4 text-[14px] text-faint"
        >
          <CodeIcon size={15} />
          Developer
          <span className="chip px-1.5 text-[10px] leading-4 text-faint">Soon</span>
        </span>
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <InboxBell />
        <AvatarMenu user={user} />
      </div>
    </header>
  );
}
