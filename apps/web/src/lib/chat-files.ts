import { ARCH_SEPARATOR, type Artifact } from '@parallelflow/contracts';

// A private chat's files panel (components/chat-artifacts.tsx): folders from the " › " in names,
// and which document is new since the panel last looked.

/** "arch › hld › hld.md" → folder "arch › hld", file "hld.md". */
export function splitName(name: string): { folder: string; file: string } {
  const parts = name.split(ARCH_SEPARATOR);
  const file = parts.pop() ?? name;
  return { folder: parts.join(ARCH_SEPARATOR), file };
}

export function groupByFolder(items: readonly Artifact[]): { folder: string; items: Artifact[] }[] {
  const groups = new Map<string, Artifact[]>();
  for (const a of items) {
    const { folder } = splitName(a.name);
    groups.set(folder, [...(groups.get(folder) ?? []), a]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([folder, list]) => ({ folder, items: list }));
}

/** Which document is newer than what the panel saw: a new one, or a new version. */
export function newest(previous: Map<string, number>, items: readonly Artifact[]): Artifact | null {
  for (const a of items) {
    const seen = previous.get(a.id);
    if (seen === undefined || seen < a.head_version_no) return a;
  }
  return null;
}
