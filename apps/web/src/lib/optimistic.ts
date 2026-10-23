'use client';

import { useEffect, useMemo, useState } from 'react';

// Optimistic sidebar entries: a dialog or composer announces an item it is creating (or has just
// created) and the sidebar shows it at once, before router.refresh() brings the server's list. An
// item the server list already has wins; a failed create removes its entry. Same tab only.

export type SidebarList = 'arenas' | 'chats' | 'projects';

interface Change<T> {
  item?: T & { id: string };
  /** The temporary id this item replaces, or the id to remove when `item` is unset. */
  replaces?: string;
}

const eventName = (list: SidebarList) => `parallelflow:optimistic:${list}`;

/** Show `item` in the sidebar now (`replaces`: drop that temporary entry). */
export function announce<T extends { id: string }>(
  list: SidebarList,
  item: T,
  replaces?: string,
): void {
  window.dispatchEvent(new CustomEvent<Change<T>>(eventName(list), { detail: { item, replaces } }));
}

/** Drop a temporary entry (its create failed). */
export function retract(list: SidebarList, id: string): void {
  window.dispatchEvent(
    new CustomEvent<Change<never>>(eventName(list), { detail: { replaces: id } }),
  );
}

export type Optimistic<T> = T & { pending?: boolean };

/**
 * The server's items plus announced ones it does not have yet: newest first (`prepend`) or last.
 */
export function useOptimisticList<T extends { id: string }>(
  list: SidebarList,
  server: readonly T[],
  prepend: boolean,
): Optimistic<T>[] {
  const [extra, setExtra] = useState<Optimistic<T>[]>([]);
  useEffect(() => {
    const onChange = (event: Event) => {
      const { item, replaces } = (event as CustomEvent<Change<T>>).detail;
      setExtra((current) => {
        const kept = current.filter((x) => x.id !== replaces && x.id !== item?.id);
        return item ? [...kept, item as Optimistic<T>] : kept;
      });
    };
    window.addEventListener(eventName(list), onChange);
    return () => window.removeEventListener(eventName(list), onChange);
  }, [list]);
  return useMemo(() => {
    const known = new Set(server.map((x) => x.id));
    const added = extra.filter((x) => !known.has(x.id));
    return prepend ? [...added.reverse(), ...server] : [...server, ...added];
  }, [server, extra, prepend]);
}

/** A temporary id for an entry being created. */
export const tempId = (): string => `pending-${Math.random().toString(36).slice(2)}`;
