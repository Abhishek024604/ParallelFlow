import {
  ARCH_SEPARATOR,
  ARCH_STATE_NAME,
  type Artifact,
  archPathOf,
} from '@parallelflow/contracts';

// Folders for private documents (the chat's files panel and My files). Names stay as stored; the
// folders are read from them:
//   - "checkout › spec.md", "pm › backlog › STORY-001.md": the " › " parts are folders;
//   - SWA's files keep standard arena names (ADR-038: "architecture-ADR-0003-hosting-model.md",
//     "lld-CMP-001--openapi.yaml") that map back to their arch/ path, so they file under
//     Architecture › Decisions, Architecture › LLD › CMP-001, … (contracts arch-docs.ts).
// SWA's own state file is not shown.

const ARCH_ROOT = 'Architecture';
export const ARCH_FOLDERS: Record<string, string> = {
  inputs: 'Inputs',
  decisions: 'Decisions',
  hld: 'HLD',
  lld: 'LLD',
  reviews: 'Reviews',
  fitness: 'Fitness tests',
  flows: 'Flows',
  sketches: 'Sketches',
};

export interface DocPlace {
  /** Folder path, outermost first; [] for a loose file. */
  folders: string[];
  /** The name shown in the folder. */
  file: string;
}

/** Where a document sits in the folder tree, or null when it is not shown (SWA's state). */
export function docPlace(name: string): DocPlace | null {
  if (name === ARCH_STATE_NAME) return null;
  const arch = archPathOf(name);
  if (arch && !name.includes(ARCH_SEPARATOR)) {
    const parts = arch.split('/');
    const base = parts.pop() ?? name;
    // "architecture-ADR-0003-x.md" shows as "ADR-0003-x.md"; a fixed name ("requirements.md" for
    // inputs/srs.md) keeps its own name.
    const file = name.endsWith(base) ? base : name;
    return { folders: [ARCH_ROOT, ...parts.map((p) => ARCH_FOLDERS[p] ?? p)], file };
  }
  const parts = name.split(ARCH_SEPARATOR);
  const file = parts.pop() ?? name;
  return { folders: parts, file };
}

/** "arch › hld › hld.md" → folder "arch › hld", file "hld.md". */
export function splitName(name: string): { folder: string; file: string } {
  const place = docPlace(name) ?? { folders: [], file: name };
  return { folder: place.folders.join(ARCH_SEPARATOR), file: place.file };
}

export interface DocFolder {
  name: string;
  /** "Architecture › LLD": unique key of the folder. */
  path: string;
  folders: DocFolder[];
  files: { artifact: Artifact; file: string }[];
}

/** The documents as a folder tree: folders A–Z before loose files; files keep the given order. */
export function docTree(items: readonly Artifact[]): DocFolder {
  const root: DocFolder = { name: '', path: '', folders: [], files: [] };
  for (const artifact of items) {
    const place = docPlace(artifact.name);
    if (!place) continue;
    let node = root;
    for (const name of place.folders) {
      let next = node.folders.find((f) => f.name === name);
      if (!next) {
        const path = node.path ? `${node.path}${ARCH_SEPARATOR}${name}` : name;
        next = { name, path, folders: [], files: [] };
        node.folders.push(next);
      }
      node = next;
    }
    node.files.push({ artifact, file: place.file });
  }
  const sort = (node: DocFolder) => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** How many documents a folder holds, its subfolders included. */
export const folderCount = (folder: DocFolder): number =>
  folder.files.length + folder.folders.reduce((n, f) => n + folderCount(f), 0);

/** Which document is newer than what the panel saw: a new one, or a new version. */
export function newest(previous: Map<string, number>, items: readonly Artifact[]): Artifact | null {
  for (const a of items) {
    if (a.name === ARCH_STATE_NAME) continue;
    const seen = previous.get(a.id);
    if (seen === undefined || seen < a.head_version_no) return a;
  }
  return null;
}
