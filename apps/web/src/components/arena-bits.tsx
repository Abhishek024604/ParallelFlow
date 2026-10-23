import type { ArenaSummary } from '@parallelflow/contracts';

// Small arena pieces shared by server pages and the (client) sidebar.

export function ArenaKey({ arenaKey, size = 'sm' }: { arenaKey: string; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'h-10 w-10 text-[11px]' : 'h-8 w-8 text-[10px]';
  return (
    <span
      aria-hidden="true"
      className={`mono inline-flex shrink-0 items-center justify-center rounded-lg border border-line bg-panel font-semibold text-muted ${box}`}
    >
      {arenaKey}
    </span>
  );
}

export function cycleLabel(arena: Pick<ArenaSummary, 'cycle' | 'stage'>): string | null {
  if (arena.cycle === null || arena.stage === null) return null;
  return `Cycle ${arena.cycle} · ${arena.stage}`;
}
