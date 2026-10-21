// SWA's arch/ files as documents (arena or private chat). Document names cannot hold "/", so the
// path's folders become " › " in the name, which is also how people see them in the chat's files:
// arch/hld/hld.md ↔ "arch › hld › hld.md". The mapping is exact both ways (arch/ path segments are
// letters, digits, ".", "_" and "-", never "›").

export const ARCH_SEPARATOR = ' › ';
const PREFIX = `arch${ARCH_SEPARATOR}`;

/** The document name for an arch/ path ("hld/hld.md" or "arch/hld/hld.md"). */
export function archDocName(path: string): string {
  const rel = path.replace(/^arch\//, '');
  return `${PREFIX}${rel.split('/').join(ARCH_SEPARATOR)}`;
}

/** The arch/ path (relative to arch/) of a document name, or null when it is not an arch/ file. */
export function archPathOf(name: string): string | null {
  if (!name.startsWith(PREFIX)) return null;
  const rel = name.slice(PREFIX.length).split(ARCH_SEPARATOR).join('/');
  return rel ? rel : null;
}

export const isArchDocName = (name: string): boolean => archPathOf(name) !== null;
