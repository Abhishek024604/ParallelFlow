import type { Artifact } from '@saras/contracts';

// A document's status chip in the arena's Files list.

export function artifactStatus(a: Pick<Artifact, 'approved_version_no' | 'head_version_no'>): {
  label: string;
  tone: '' | 'ok';
} {
  if (a.approved_version_no === null) return { label: 'draft', tone: '' };
  if (a.approved_version_no === a.head_version_no) return { label: 'approved', tone: 'ok' };
  return { label: `v${a.approved_version_no} approved`, tone: 'ok' };
}

/** The Approved tab: documents with an approved (and committed) version. */
export const isApproved = (a: Pick<Artifact, 'approved_version_no'>): boolean =>
  a.approved_version_no !== null;
