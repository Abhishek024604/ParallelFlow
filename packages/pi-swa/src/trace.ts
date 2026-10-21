import { readModel } from './model.js';
import type { ArchStore } from './store.js';
import { definedIds } from './validate.js';

// swa_trace: the requirement ↔ component matrix (docs/15 "Traceability IDs"): FR/NFR/CON →
// CMP (model.yaml `satisfies`) → ADR (`adrs`) → code paths (`code`). It feeds the HLD review, the
// code review and impact analysis.

export interface TraceRow {
  requirement: string;
  components: string[];
  adrs: string[];
  code: string[];
}

export interface TraceReport {
  rows: TraceRow[];
  /** FRs and NFRs no component satisfies. */
  unsatisfied: string[];
  /** Components that satisfy nothing. */
  orphans: string[];
  /** Ids a component cites that are not defined. */
  dangling: string[];
  /** Components with no code paths yet (code review needs them). */
  noCode: string[];
}

export async function trace(store: ArchStore): Promise<TraceReport | null> {
  const parsed = await readModel(store);
  if (!parsed) return null;
  const { model } = parsed;
  const ids = await definedIds(store);
  const requirements = [...ids.keys()].filter((id) => /^(FR|NFR|CON)-/.test(id)).sort(byId);
  const rows = requirements.map((requirement) => {
    const comps = model.components.filter((c) => c.satisfies.includes(requirement));
    return {
      requirement,
      components: comps.map((c) => c.id),
      adrs: [...new Set(comps.flatMap((c) => c.adrs))].sort(byId),
      code: [...new Set(comps.flatMap((c) => c.code))],
    };
  });
  const dangling = new Set<string>();
  for (const c of model.components) {
    for (const id of [...c.satisfies, ...c.adrs]) if (!ids.has(id)) dangling.add(`${c.id} → ${id}`);
  }
  return {
    rows,
    unsatisfied: rows
      .filter((r) => !r.components.length && !r.requirement.startsWith('CON-'))
      .map((r) => r.requirement),
    orphans: model.components.filter((c) => !c.satisfies.length).map((c) => c.id),
    dangling: [...dangling],
    noCode: model.components.filter((c) => !c.code.length).map((c) => c.id),
  };
}

/** FR-2 before FR-10. */
function byId(a: string, b: string): number {
  const [pa = '', na = '0'] = a.split('-');
  const [pb = '', nb = '0'] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
}

export function renderTrace(r: TraceReport | null): string {
  if (!r) return 'arch/model.yaml does not exist yet: run /swa hld first.';
  const covered = r.rows.filter((x) => x.components.length).length;
  const lines = [
    `Traceability: ${covered} of ${r.rows.length} requirements map to a component.`,
    '',
    '| Requirement | Components | ADRs | Code |',
    '| --- | --- | --- | --- |',
    ...r.rows.map(
      (x) =>
        `| ${x.requirement} | ${x.components.join(', ') || '—'} | ${x.adrs.join(', ') || '—'} | ${x.code.join(', ') || '—'} |`,
    ),
  ];
  if (r.unsatisfied.length)
    lines.push('', `GAP: no component satisfies ${r.unsatisfied.join(', ')}.`);
  if (r.orphans.length) lines.push(`GAP: ${r.orphans.join(', ')} satisfy no requirement.`);
  if (r.dangling.length) lines.push(`GAP: undefined ids cited: ${r.dangling.join('; ')}.`);
  if (r.noCode.length) lines.push(`Note: no code paths yet for ${r.noCode.join(', ')}.`);
  return lines.join('\n');
}
