import type { Artifact } from '@saras/contracts';

// A document's status chip in the arena's Files list.

export function artifactStatus(
  a: Pick<Artifact, 'approved_version_no' | 'head_version_no'> & { kind?: Artifact['kind'] },
): { label: string; tone: '' | 'ok' } {
  // The progress log is written by the app and the AI, never approved.
  if (a.kind === 'progress') return { label: 'log', tone: '' };
  if (a.approved_version_no === null) return { label: 'draft', tone: '' };
  if (a.approved_version_no === a.head_version_no) return { label: 'approved', tone: 'ok' };
  return { label: `v${a.approved_version_no} approved`, tone: 'ok' };
}

/** The Approved tab: documents with an approved (and committed) version. */
export const isApproved = (a: Pick<Artifact, 'approved_version_no'>): boolean =>
  a.approved_version_no !== null;
