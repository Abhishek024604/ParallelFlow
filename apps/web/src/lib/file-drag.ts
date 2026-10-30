import {
  encodeDragPayload,
  FILE_DRAG_TYPE,
  type FileDragPayload,
  parseDragPayload,
} from '@parallelflow/contracts';
import { type DragEvent, useState } from 'react';

// Drag and drop of files in the web app (ADR-041): a private file or folder onto a folder, a chat or
// an arena; an arena file onto a chat or Private. The drag carries ids (and a folder path), never
// content, under FILE_DRAG_TYPE. While dragging, a browser only shows a drag's types, so each drag
// also sets an empty marker type for its kind: drop targets light up only for what they accept.
// Escape cancels a drag (the browser ends it; dragend clears the highlight). Every drag has a menu
// equivalent in the row menus, and results are announced (announce()).

export type DragKind = FileDragPayload['kind'];

const marker = (kind: DragKind) => `${FILE_DRAG_TYPE}-${kind}`;

/** Starts a drag of one of our files or folders. */
export function startFileDrag(event: DragEvent, payload: FileDragPayload): void {
  event.dataTransfer.setData(FILE_DRAG_TYPE, encodeDragPayload(payload));
  event.dataTransfer.setData(marker(payload.kind), '');
  event.dataTransfer.effectAllowed = payload.kind === 'arena' ? 'copy' : 'copyMove';
}

/** The kind of our drag in progress, from its types (null: not ours). */
export function dragKind(types: Iterable<string>): DragKind | null {
  const list = Array.from(types, (t) => t.toLowerCase());
  if (!list.includes(FILE_DRAG_TYPE)) return null;
  for (const kind of ['private', 'folder', 'arena'] as const) {
    if (list.includes(marker(kind))) return kind;
  }
  return null;
}

/** The payload on drop (null: not ours, or malformed). */
export function readFileDrag(event: DragEvent): FileDragPayload | null {
  return parseDragPayload(event.dataTransfer.getData(FILE_DRAG_TYPE));
}

/**
 * Drop handlers for one target that accepts `kinds`; `over` is true while an accepted drag is over
 * it (a visible drop target). Nested children do not make it flicker.
 */
export function useDropTarget(
  kinds: readonly DragKind[],
  onDrop: (payload: FileDragPayload) => void,
) {
  const [over, setOver] = useState(false);
  const accepts = (event: DragEvent) => {
    const kind = dragKind(event.dataTransfer.types);
    return kind !== null && kinds.includes(kind);
  };
  return {
    over,
    props: {
      onDragOver: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect =
          dragKind(event.dataTransfer.types) === 'arena' ? 'copy' : 'move';
        if (!over) setOver(true);
      },
      onDragLeave: (event: DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (event: DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        const payload = readFileDrag(event);
        if (payload && kinds.includes(payload.kind)) onDrop(payload);
      },
    },
  };
}

/** Class for a drop target while a drag is over it. */
export const DROP_OVER = 'rounded-lg bg-raise ring-1 ring-line2';

/** Polite screen reader message (the app layout's live region, top-bar.tsx). */
export const ANNOUNCE_EVENT = 'parallelflow:announce';

export function announce(text: string): void {
  window.dispatchEvent(new CustomEvent<string>(ANNOUNCE_EVENT, { detail: text }));
}

/** Opens the copy dialog from anywhere (an arena file dropped on Private, the viewer, a menu). */
export const COPY_TO_CHAT_EVENT = 'parallelflow:copy-to-chat';
/** Opens the Push dialog from anywhere (a private file dropped on an arena). */
export const PUSH_FILE_EVENT = 'parallelflow:push-file';

export interface CopyToChatRequest {
  projectId: string;
  artifactIds: string[];
  /** The chat it was dropped on, if any. */
  chatId?: string;
}

export interface PushFileRequest {
  artifactId: string;
  /** The arena it was dropped on, if any. */
  projectId?: string;
}

export function requestCopyToChat(detail: CopyToChatRequest): void {
  window.dispatchEvent(new CustomEvent<CopyToChatRequest>(COPY_TO_CHAT_EVENT, { detail }));
}

export function requestPush(detail: PushFileRequest): void {
  window.dispatchEvent(new CustomEvent<PushFileRequest>(PUSH_FILE_EVENT, { detail }));
}

/** Opens the Push folder dialog from anywhere (a folder's menu, a folder dropped on Arena). */
export const PUSH_FOLDER_EVENT = 'parallelflow:push-folder';

export interface PushFolderRequest {
  /** The chat that holds the folder. */
  chatId: string;
  /** The folder's path in that chat's tree ("Architecture › LLD"). */
  path: string;
  /** The arena it was dropped on, if any. */
  projectId?: string;
}

export function requestPushFolder(detail: PushFolderRequest): void {
  window.dispatchEvent(new CustomEvent<PushFolderRequest>(PUSH_FOLDER_EVENT, { detail }));
}
