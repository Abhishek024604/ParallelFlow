'use client';

import type { Artifact } from '@parallelflow/contracts';
import type { ReactNode } from 'react';
import { type DocFolder, docTree, folderCount } from '../lib/chat-files';
import { ChevronDownIcon, FolderIcon } from './icons';

// Private documents as a folder tree (lib/chat-files.ts): the chat's files panel and My files.
// Folders open and close on click (native <details>, keyboard accessible); loose files sit
// below the folders. `row` draws one file.

export type DocRow = (artifact: Artifact, file: string) => ReactNode;

export function DocTree({ items, row }: { items: readonly Artifact[]; row: DocRow }) {
  const root = docTree(items);
  return <FolderBody folder={root} row={row} depth={0} />;
}

function FolderBody({ folder, row, depth }: { folder: DocFolder; row: DocRow; depth: number }) {
  return (
    <>
      {folder.folders.map((child) => (
        <details key={child.path} open className="group">
          <summary
            className="nav flex cursor-pointer list-none items-center gap-2 py-1.5 pr-4 text-[13px] font-semibold text-muted [&::-webkit-details-marker]:hidden"
            style={{ paddingLeft: 16 + depth * 14 }}
          >
            <ChevronDownIcon
              size={12}
              className="shrink-0 -rotate-90 transition-transform group-open:rotate-0"
            />
            <FolderIcon size={14} />
            <span className="min-w-0 flex-1 truncate">{child.name}</span>
            <span className="text-[12px] font-normal text-faint">{folderCount(child)}</span>
          </summary>
          <FolderBody folder={child} row={row} depth={depth + 1} />
        </details>
      ))}
      {folder.files.length > 0 && (
        <ul style={{ paddingLeft: depth * 14 }}>
          {folder.files.map(({ artifact, file }) => (
            <li key={artifact.id}>{row(artifact, file)}</li>
          ))}
        </ul>
      )}
    </>
  );
}
