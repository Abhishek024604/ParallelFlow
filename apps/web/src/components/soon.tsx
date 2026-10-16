import type { ReactNode } from 'react';

// Controls for features that land in later build steps. They are visibly disabled (aria-disabled,
// still focusable so the hint is reachable by keyboard) and say "Coming soon" on hover or focus.
// Nothing here pretends to work.

export function SoonTip({
  children,
  label = 'Coming soon',
  side = 'right',
}: {
  children: ReactNode;
  label?: string;
  side?: 'right' | 'bottom' | 'top';
}) {
  const position =
    side === 'right'
      ? 'left-full top-1/2 ml-2 -translate-y-1/2'
      : side === 'top'
        ? 'bottom-full left-1/2 mb-2 -translate-x-1/2'
        : 'top-full left-1/2 mt-2 -translate-x-1/2';
  return (
    <span className="group relative inline-flex w-full">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-30 hidden whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[12px] font-medium text-on-ink shadow-pop group-focus-within:block group-hover:block ${position}`}
      >
        {label}
      </span>
    </span>
  );
}

/** A disabled row button with the "Coming soon" hint. */
export function SoonButton({
  children,
  className = '',
  side,
}: {
  children: ReactNode;
  className?: string;
  side?: 'right' | 'bottom' | 'top';
}) {
  return (
    <SoonTip side={side}>
      <button
        type="button"
        aria-disabled="true"
        className={`cursor-not-allowed opacity-55 ${className}`}
      >
        {children}
      </button>
    </SoonTip>
  );
}
