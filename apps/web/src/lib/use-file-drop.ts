'use client';

import { type DragEvent, useRef, useState } from 'react';

// Drag and drop of files onto a composer. Only drags that carry files count (a dragged chat or text
// is ignored), and nested elements do not make the drop zone flicker (enter/leave are counted).

/** Whether a drag carries files (its dataTransfer types), not text or a dragged chat. */
export const dragHasFiles = (types: Iterable<string>): boolean =>
  Array.from(types).includes('Files');

const hasFiles = (event: DragEvent) => dragHasFiles(event.dataTransfer.types);

export function useFileDrop(onFiles: (files: FileList) => void, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handlers = enabled
    ? {
        onDragEnter: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          depth.current += 1;
          setDragging(true);
        },
        onDragOver: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        },
        onDrop: (event: DragEvent) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          if (event.dataTransfer.files.length > 0) onFiles(event.dataTransfer.files);
        },
      }
    : {};
  return { dragging, handlers };
}
