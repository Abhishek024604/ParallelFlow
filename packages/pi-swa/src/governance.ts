import { parse } from 'yaml';
import { readFrontmatter } from './markdown.js';
import type { SwaResources } from './resources.js';
import type { ArchStore } from './store.js';

// swa_governance_check: stack.md's `stack` list against the governance YAML (arch/inputs/
// governance.yaml, else the default pack). Technology rules are matched by name; every rule with an
// id (SEC-*, STD-*, …) must be addressed by stack.md, which means citing the id in its text.

export interface StackEntry {
  layer: string;
  tech: string;
  adr?: string;
}

interface Rule {
  name?: string;
  id?: string;
  rule?: string;
  reason?: string;
}

export interface GovernanceReport {
  source: string;
  stack: StackEntry[];
  forbidden: { tech: string; reason: string }[];
  notAllowed: string[];
  requiredMissing: string[];
  unaddressed: { id: string; rule: string }[];
  problems: string[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** stack.md frontmatter `stack: [{layer, tech, adr}]`. */
export function stackEntries(stackMd: string): StackEntry[] {
  const raw = readFrontmatter(stackMd).data['stack'];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .filter((e) => typeof e['tech'] === 'string')
    .map((e) => ({
      layer: typeof e['layer'] === 'string' ? e['layer'] : '',
      tech: String(e['tech']),
      ...(typeof e['adr'] === 'string' && { adr: e['adr'] }),
    }));
}

const rules = (v: unknown): Rule[] =>
  Array.isArray(v) ? v.map((r) => (typeof r === 'string' ? { name: r } : ((r ?? {}) as Rule))) : [];

/** Every list of rules with ids, wherever it sits in the file (security.required, standards.api, …). */
function idRules(doc: unknown): { id: string; rule: string }[] {
  const out: { id: string; rule: string }[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && typeof (item as Rule).id === 'string') {
          out.push({ id: String((item as Rule).id), rule: String((item as Rule).rule ?? '') });
        } else walk(item);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) if (k !== 'technology') walk(child);
    }
  };
  walk(doc);
  return out;
}

export async function governanceCheck(
  store: ArchStore,
  resources: SwaResources,
): Promise<GovernanceReport> {
  const own = await store.read('inputs/governance.yaml');
  const source = own === null ? 'the default governance pack' : 'arch/inputs/governance.yaml';
  const report: GovernanceReport = {
    source,
    stack: [],
    forbidden: [],
    notAllowed: [],
    requiredMissing: [],
    unaddressed: [],
    problems: [],
  };
  let doc: Record<string, unknown>;
  try {
    doc = (parse(own ?? resources.template('governance.default.yaml')) ?? {}) as Record<
      string,
      unknown
    >;
  } catch (err) {
    report.problems.push(`${source} is not valid YAML (${(err as Error).message.split('\n')[0]})`);
    return report;
  }
  const stackMd = await store.read('stack.md');
  if (stackMd === null) {
    report.problems.push('arch/stack.md does not exist yet.');
    return report;
  }
  report.stack = stackEntries(stackMd);
  if (!report.stack.length) {
    report.problems.push(
      'arch/stack.md has no `stack` list in its frontmatter ([{layer, tech, adr}]).',
    );
  }
  const tech = (doc['technology'] ?? {}) as Record<string, unknown>;
  const forbidden = rules(tech['forbidden']);
  const allowed = rules(tech['allowed']).map((r) => norm(r.name ?? ''));
  const required = rules(tech['required']);
  for (const entry of report.stack) {
    const hit = forbidden.find((r) => r.name && norm(r.name) === norm(entry.tech));
    if (hit) report.forbidden.push({ tech: entry.tech, reason: hit.reason ?? 'forbidden' });
    else if (allowed.length && !allowed.includes(norm(entry.tech)))
      report.notAllowed.push(entry.tech);
  }
  for (const r of required) {
    if (r.name && !report.stack.some((e) => norm(e.tech) === norm(r.name as string))) {
      report.requiredMissing.push(r.name);
    }
  }
  report.unaddressed = idRules(doc).filter((r) => !stackMd.includes(r.id));
  return report;
}

export function renderGovernance(r: GovernanceReport): string {
  const lines = [`Governance check against ${r.source}.`];
  lines.push(...r.problems.map((p) => `Problem: ${p}`));
  if (r.stack.length) lines.push(`Stack: ${r.stack.map((e) => e.tech).join(', ')}.`);
  lines.push(...r.forbidden.map((f) => `FORBIDDEN: ${f.tech} (${f.reason})`));
  if (r.notAllowed.length) lines.push(`NOT ON THE ALLOWED LIST: ${r.notAllowed.join(', ')}`);
  if (r.requiredMissing.length) lines.push(`REQUIRED BUT MISSING: ${r.requiredMissing.join(', ')}`);
  if (r.unaddressed.length) {
    lines.push('Rules stack.md does not address yet (cite each id where the stack meets it):');
    lines.push(...r.unaddressed.map((u) => `- ${u.id}: ${u.rule}`));
  }
  const clean =
    !r.problems.length &&
    !r.forbidden.length &&
    !r.notAllowed.length &&
    !r.requiredMissing.length &&
    !r.unaddressed.length;
  if (clean) lines.push('Compliant: no violations, every rule addressed.');
  return lines.join('\n');
}

export const governanceClean = (r: GovernanceReport): boolean =>
  !r.problems.length && !r.forbidden.length && !r.notAllowed.length && !r.requiredMissing.length;
