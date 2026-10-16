import {
  FILE_MAX_BYTES,
  formatBytes,
  isUploadType,
  type UploadType,
  uploadTypeForName,
} from '@saras/contracts';

/** The allowlisted type of a picked file (browser type first, then its extension), or an error. */
export function uploadTypeOf(file: {
  name: string;
  type: string;
  size: number;
}): { type: UploadType } | { error: string } {
  if (file.size === 0) return { error: `${file.name} is empty.` };
  if (file.size > FILE_MAX_BYTES) {
    return { error: `${file.name} is larger than ${formatBytes(FILE_MAX_BYTES)}.` };
  }
  const type = isUploadType(file.type) ? file.type : uploadTypeForName(file.name);
  if (!type) {
    return { error: `${file.name}: use an image, PDF, text, markdown, CSV or JSON file.` };
  }
  return { type };
}

/** "edited 4 min ago". */
export function editedAgo(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'edited just now';
  if (minutes < 60) return `edited ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `edited ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `edited ${days} ${days === 1 ? 'day' : 'days'} ago`;
}
