'use client';

import { ARCH_SEPARATOR, type Artifact, archPathOf } from '@parallelflow/contracts';
import type { ReactNode } from 'react';
import { type DocFolder, docTree, folderCount } from '../lib/chat-files';
import { DROP_OVER, startFileDrag, useDropTarget } from '../lib/file-drag';
import { ChevronDownIcon, FolderIcon } from './icons';

// Private documents as a folder tree (lib/chat-files.ts): the chat's files panel and My files.
// Folders open and close on click (native <details>, keyboard accessible); loose files sit
// below the folders. `row` draws one file.
// With `moves` (ADR-041) files and folders drag onto a folder, or anywhere else in the tree for the
// top level; the row menus offer the same moves for keyboards. SWA's architecture folders are read
// from standard file names, so they are not drop targets and do not drag as folders.

export type DocRow = (artifact: Artifact, file: string) => ReactNode;

export interface TreeMoves {
  /** The chat the tree belongs to (null: My files, all of your files). */
  chatId: string | null;
  onFileToFolder: (artifactId: string, folder: string) => void;
  onFolderToFolder: (from: string, toParent: string) => void;
}

/** Whether a file's folder comes from its name's " › " parts (not SWA's standard names). */
export const hasLiteralFolder = (name: string): boolean =>
  !(archPathOf(name) && !name.includes(ARCH_SEPARATOR));

const literalFolder = (folder: DocFolder): boolean =>
  folder.files.every((f) => hasLiteralFolder(f.artifact.name)) &&
  folder.folders.every(literalFolder);

export function DocTree({
  items,
  row,
  moves,
}: {
  items: readonly Artifact[];
  row: DocRow;
  moves?: TreeMoves;
}) {
  const root = docTree(items);
  if (!moves) return <FolderBody folder={root} row={row} depth={0} />;
  return <RootDrop folder={root} row={row} moves={moves} />;
}

function onDropInto(moves: TreeMoves, path: string) {
  return (payload: Parameters<Parameters<typeof useDropTarget>[1]>[0]) => {
    if (payload.kind === 'private') moves.onFileToFolder(payload.artifact_id, path);
    else if (payload.kind === 'folder') moves.onFolderToFolder(payload.path, path);
  };
}

function RootDrop({ folder, row, moves }: { folder: DocFolder; row: DocRow; moves: TreeMoves }) {
  const drop = useDropTarget(['private', 'folder'], onDropInto(moves, ''));
  return (
    <div {...drop.props} className={`min-h-[48px] ${drop.over ? DROP_OVER : ''}`}>
      <FolderBody folder={folder} row={row} depth={0} moves={moves} />
    </div>
  );
}

function FolderBody({
  folder,
  row,
  depth,
  moves,
}: {
  folder: DocFolder;
  row: DocRow;
  depth: number;
  moves?: TreeMoves;
}) {
  return (
    <>
      {folder.folders.map((child) => (
        <FolderNode key={child.path} folder={child} row={row} depth={depth} moves={moves} />
      ))}
      {folder.files.length > 0 && (
        <ul style={{ paddingLeft: depth * 14 }}>
          {folder.files.map(({ artifact, file }) => (
            <li
              key={artifact.id}
              draggable={Boolean(moves)}
              onDragStart={
                moves
                  ? (event) =>
                      startFileDrag(event, {
                        kind: 'private',
                        artifact_id: artifact.id,
                        chat_id: artifact.private_session_id,
                      })
                  : undefined
              }
            >
              {row(artifact, file)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FolderNode({
  folder,
  row,
  depth,
  moves,
}: {
  folder: DocFolder;
  row: DocRow;
  depth: number;
  moves?: TreeMoves;
}) {
  const movable = Boolean(moves) && literalFolder(folder);
  const drop = useDropTarget(
    movable ? ['private', 'folder'] : [],
    moves ? onDropInto(moves, folder.path) : () => undefined,
  );
  return (
    <details open className={`group ${drop.over ? DROP_OVER : ''}`} {...drop.props}>
      <summary
        draggable={movable}
        onDragStart={
          movable && moves
            ? (event) =>
                startFileDrag(event, { kind: 'folder', chat_id: moves.chatId, path: folder.path })
            : undefined
        }
        className="nav flex cursor-pointer list-none items-center gap-2 py-1.5 pr-4 text-[13px] font-semibold text-muted [&::-webkit-details-marker]:hidden"
        style={{ paddingLeft: 16 + depth * 14 }}
      >
        <ChevronDownIcon
          size={12}
          className="shrink-0 -rotate-90 transition-transform group-open:rotate-0"
        />
        <FolderIcon size={14} />
        <span className="min-w-0 flex-1 truncate">{folder.name}</span>
        <span className="text-[12px] font-normal text-faint">{folderCount(folder)}</span>
      </summary>
      <FolderBody folder={folder} row={row} depth={depth + 1} moves={moves} />
    </details>
  );
}
