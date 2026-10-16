'use client';

import { useEffect, useId, useRef, useState } from 'react';

// A small "⋯" menu for a row (rename, delete, …). Opens below its button; closes on pick, Escape or
// a click elsewhere. Arrow keys move between items.

export interface RowMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}

export function RowMenu({
  label,
  items,
  align = 'right',
}: {
  label: string;
  items: RowMenuItem[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="btn ghost h-8 w-8 p-0 text-[16px] leading-none text-faint"
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            const buttons = [
              ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
            ];
            const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              buttons[(at + step + buttons.length) % buttons.length]?.focus();
            }
          }}
          className={`card absolute top-full z-30 mt-1 min-w-[150px] p-1 shadow-pop ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`nav flex h-8 w-full items-center px-2.5 text-left text-[14px] ${
                item.danger ? 'text-bad' : 'text-text'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
