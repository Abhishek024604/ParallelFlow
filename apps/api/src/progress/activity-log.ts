// PROGRESS.md as the arena's activity log (ADR-044). Pure and deterministic: the same events and
// facts always render the same text (no clock, no AI); unit tested. The events come from
// audit_events (packages/db events.ts); only the metadata fields named below are ever printed, so
// nothing else a writer stored can reach the file. Layout:
//
//   # Activity log: <arena>
//   > what this file is
//   ## Now                      one table: cycle, stage, open gate, members, open PRs
//   ## 2026-11-03               one section per UTC day, newest first, the last 60 days
//   ### Loop                    groups in a fixed order: Loop, Code, Files, Team, AI, Settings;
//   - 14:02 · Asha (Owner) · approved gate · **Design → Build** · 2/2 approvals · `evt-41`
//   ## Earlier                  links to the monthly archives (docs/progress/YYYY-MM.md)
//
// Each line: time · actor (roles) · verb · object · detail · event id. Newest first in a group.

export const ACTIVITY_TITLE_PREFIX = '# Activity log: ';
/** Days kept in PROGRESS.md; older days move to the monthly archives. */
export const ACTIVITY_DAYS = 60;
export const ARCHIVE_DIR = 'docs/progress';

export type ActivityGroup = 'Loop' | 'Code' | 'Files' | 'Team' | 'AI' | 'Settings';
export const GROUP_ORDER: readonly ActivityGroup[] = [
  'Loop',
  'Code',
  'Files',
  'Team',
  'AI',
  'Settings',
];

export interface ActivityEvent {
  /** audit_events.id (bigserial, as text). */
  id: string;
  /** ISO instant. */
  at: string;
  action: string;
  actorType: 'user' | 'agent' | 'service';
  /** The person's name (user actors), when known. */
  actorName: string | null;
  /** The person's current roles in the arena, Owner first. */
  actorRoles: readonly string[];
  /** The name of the person an event is about (role changes), when known. */
  targetName: string | null;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ActivityNow {
  cycle: number | null;
  stage: string | null;
  /** The open gate, if any. */
  gate: { stage: string; to: string | null; approvals: number; required: number } | null;
  members: number;
  openPulls: number;
}

export interface ActivityInput {
  arenaName: string;
  now: ActivityNow;
  /** Any order; sorted here. */
  events: readonly ActivityEvent[];
  /** Today (UTC, yyyy-mm-dd): days older than ACTIVITY_DAYS before it are archived. */
  today: string;
  /** A legacy log is published at docs/progress/legacy.md: link it. */
  hasLegacy?: boolean;
}

export interface ActivityFiles {
  /** PROGRESS.md */
  progress: string;
  /** docs/progress/YYYY-MM.md, newest month first. */
  archives: { month: string; path: string; content: string }[];
}

// ---------------------------------------------------------------- text helpers

/** Markdown-safe inline text: one line, cut, and the characters that format or break a table escaped. */
export function md(value: unknown, max = 120): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  return cut.replace(/([\\`*_[\]<>|#~])/g, '\\$1');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "BUILD" → "Build". */
export function stageName(stage: unknown): string {
  const s = str(stage);
  return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '?';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function size(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const bold = (text: string) => `**${text}**`;
/** A short commit sha as code, only when it is one. */
const sha = (m: Readonly<Record<string, unknown>>) =>
  typeof m.sha === 'string' && /^[0-9a-f]{7,40}$/.test(m.sha) ? `\`${m.sha.slice(0, 7)}\`` : null;
const gate = (m: Readonly<Record<string, unknown>>) =>
  bold(`${stageName(m.stage)} → ${str(m.to) ? stageName(m.to) : 'next'}`);
const file = (m: Readonly<Record<string, unknown>>) => bold(md(m.name ?? 'a file'));
const version = (m: Readonly<Record<string, unknown>>) =>
  num(m.version) !== null ? `v${num(m.version)}` : null;
const pr = (m: Readonly<Record<string, unknown>>) => bold(`PR #${num(m.number) ?? '?'}`);
const title = (m: Readonly<Record<string, unknown>>) =>
  str(m.title) ? `*${md(m.title, 80)}*` : null;
const votes = (m: Readonly<Record<string, unknown>>) =>
  num(m.approvals) !== null && num(m.required) !== null
    ? `${num(m.approvals)}/${num(m.required)} approvals`
    : null;

// ---------------------------------------------------------------- events → lines

interface Described {
  group: ActivityGroup;
  verb: string;
  object?: string | null;
  details?: (string | null | undefined)[];
  /** Lines under the event (a push's commit subjects). */
  children?: string[];
}

const PR_CHANGE: Record<string, string> = {
  synchronize: 'new commits',
  edited: 'edited',
  ready_for_review: 'ready for review',
  converted_to_draft: 'back to draft',
};

const REVIEW_VERB: Record<string, string> = {
  approve: 'approved',
  request_changes: 'requested changes on',
  comment: 'commented on',
};

/** What an event says. Unknown actions still get a line (their name), never their metadata. */
export function describe(e: ActivityEvent): Described {
  const m = e.metadata;
  const target = e.targetName ? md(e.targetName, 60) : 'a teammate';
  switch (e.action) {
    // Loop
    case 'loop.cycle.started':
      return {
        group: 'Loop',
        verb: 'started',
        object: bold(`Cycle ${num(m.cycle) ?? '?'}`),
        details: [str(m.stage) ? `in ${stageName(m.stage)}` : null],
      };
    case 'loop.cycle.closed':
      return { group: 'Loop', verb: 'closed', object: bold(`Cycle ${num(m.cycle) ?? '?'}`) };
    case 'loop.stage.moved':
      return {
        group: 'Loop',
        verb: 'moved the stage',
        object: bold(`${stageName(m.from)} → ${stageName(m.to)}`),
        details: [num(m.cycle) !== null ? `cycle ${num(m.cycle)}` : null],
      };
    case 'loop.stage.sent_back':
      return {
        group: 'Loop',
        verb: 'sent the cycle back',
        object: bold(`${stageName(m.from)} → ${stageName(m.to)}`),
        details: [
          num(m.cycle) !== null ? `cycle ${num(m.cycle)}` : null,
          m.cancelled_gate === true ? 'open gate cancelled' : null,
        ],
      };
    case 'loop.gate.requested':
      return {
        group: 'Loop',
        verb: 'requested gate',
        object: gate(m),
        details: [
          num(m.required) !== null ? `needs ${plural(num(m.required) ?? 1, 'approval')}` : null,
        ],
      };
    case 'loop.gate.voted':
      return {
        group: 'Loop',
        verb: m.decision === 'reject' ? 'voted to reject gate' : 'voted to approve gate',
        object: gate(m),
        details: [votes(m)],
      };
    case 'loop.gate.approved':
      return { group: 'Loop', verb: 'approved gate', object: gate(m), details: [votes(m)] };
    case 'loop.gate.rejected':
      return { group: 'Loop', verb: 'rejected gate', object: gate(m), details: [votes(m)] };
    case 'loop.gate_policy.updated':
      return {
        group: 'Loop',
        verb: 'changed the gate rules',
        object: Array.isArray(m.stages) ? bold(m.stages.map((s) => stageName(s)).join(', ')) : null,
        details: [str(m.template) ? `from the ${md(m.template, 40)} template` : null],
      };

    // Code
    case 'repo.connected':
      return {
        group: 'Code',
        verb: 'connected GitHub',
        object: bold(md(m.repo ?? 'a repository', 140)),
        details: [str(m.branch) ? `default branch ${md(m.branch, 60)}` : null],
      };
    case 'repo.disconnected':
      return {
        group: 'Code',
        verb: 'disconnected GitHub',
        object: bold(md(m.repo ?? 'the repository', 140)),
      };
    case 'repo.synced':
      return { group: 'Code', verb: 'synced the repository' };
    case 'repo.commit.pushed': {
      const subjects = Array.isArray(m.commits)
        ? m.commits.filter((s): s is string => typeof s === 'string')
        : [];
      return {
        group: 'Code',
        verb: 'pushed',
        object: bold(plural(num(m.count) ?? subjects.length, 'commit')),
        details: [str(m.branch) ? `to ${md(m.branch, 60)}` : null, sha(m)],
        children: subjects.map((s) => md(s, 80)),
      };
    }
    case 'repo.branch.pushed':
      return {
        group: 'Code',
        verb: 'pushed branch',
        object: bold(md(m.branch ?? '?', 80)),
        details: [sha(m)],
      };
    case 'repo.pr.opened':
      return {
        group: 'Code',
        verb: 'opened',
        object: pr(m),
        details: [
          title(m),
          str(m.branch) ? `from ${md(m.branch, 60)}` : null,
          m.written_by_ai === true ? 'written by AI' : null,
        ],
      };
    case 'repo.pr.updated':
      return {
        group: 'Code',
        verb: 'updated',
        object: pr(m),
        details: [title(m), PR_CHANGE[String(m.change)] ?? null],
      };
    case 'repo.pr.merged':
      return {
        group: 'Code',
        verb: 'merged',
        object: pr(m),
        details: [title(m), sha(m)],
      };
    case 'repo.pr.closed':
      return { group: 'Code', verb: 'closed', object: pr(m), details: [title(m)] };
    case 'repo.pr.reopened':
      return { group: 'Code', verb: 'reopened', object: pr(m), details: [title(m)] };
    case 'repo.review.submitted':
      return {
        group: 'Code',
        verb: REVIEW_VERB[String(m.decision)] ?? 'reviewed',
        object: pr(m),
        details: [title(m)],
      };

    // Files
    case 'file.uploaded':
      return {
        group: 'Files',
        verb: 'uploaded',
        object: file(m),
        details: [str(m.mime_type) ? md(m.mime_type, 60) : null, size(num(m.size_bytes))],
      };
    case 'file.created':
      return { group: 'Files', verb: 'created', object: file(m), details: [version(m)] };
    case 'file.version_added':
      return { group: 'Files', verb: 'added a version of', object: file(m), details: [version(m)] };
    case 'file.renamed':
      return {
        group: 'Files',
        verb: 'renamed',
        object: file(m),
        details: [str(m.from) ? `from ${md(m.from, 80)}` : null],
      };
    case 'file.moved':
      return { group: 'Files', verb: 'moved', object: file(m) };
    case 'file.deleted':
      return { group: 'Files', verb: 'deleted', object: file(m) };
    case 'file.restored':
      return { group: 'Files', verb: 'restored', object: file(m) };
    case 'file.approved':
      return {
        group: 'Files',
        verb: 'approved',
        object: file(m),
        details: [version(m), str(m.stage) ? `at the ${stageName(m.stage)} gate` : null],
      };
    case 'file.pushed_from_private':
      return {
        group: 'Files',
        verb: 'pushed',
        object: file(m),
        details: [version(m), 'from a private chat'],
      };
    case 'file.copied_to_private':
      return {
        group: 'Files',
        verb: 'copied',
        object: file(m),
        details: [version(m), 'into a private chat'],
      };

    // Team
    case 'team.member.invited':
      return {
        group: 'Team',
        verb: 'invited',
        object: bold(plural(num(m.count) ?? 1, 'teammate')),
        details: ['by email'],
      };
    case 'team.member.joined':
      return {
        group: 'Team',
        verb: 'joined the arena',
        details: [
          m.via === 'link' ? 'with the arena link' : m.via === 'invite' ? 'from an invite' : null,
        ],
      };
    case 'team.member.removed':
      return { group: 'Team', verb: 'removed', object: bold(target) };
    case 'team.member.left':
      return { group: 'Team', verb: 'left the arena' };
    case 'team.role.assigned':
      return {
        group: 'Team',
        verb: 'gave',
        object: bold(md(m.role ?? 'a role', 60)),
        details: [`to ${target}`],
      };
    case 'team.role.unassigned':
      return {
        group: 'Team',
        verb: 'took',
        object: bold(md(m.role ?? 'a role', 60)),
        details: [`from ${target}`],
      };
    case 'team.role.created':
      return {
        group: 'Team',
        verb: 'created role',
        object: bold(md(m.name ?? '?', 60)),
        details: [
          num(m.capabilities) !== null ? plural(num(m.capabilities) ?? 0, 'permission') : null,
        ],
      };
    case 'team.role.updated':
      return {
        group: 'Team',
        verb: 'changed role',
        object: bold(md(m.name ?? '?', 60)),
        details: [
          [
            m.renamed === true ? 'name' : null,
            m.capabilities_changed === true ? 'permissions' : null,
            m.stages_changed === true ? 'stages' : null,
          ]
            .filter(Boolean)
            .join(', ') || null,
        ],
      };
    case 'team.role.deleted':
      return { group: 'Team', verb: 'deleted role', object: bold(md(m.name ?? '?', 60)) };
    case 'team.roles.template_applied':
      return {
        group: 'Team',
        verb: 'applied the role template',
        object: bold(md(m.template ?? '?', 60)),
        details: [num(m.created) !== null ? plural(num(m.created) ?? 0, 'new role') : null],
      };
    case 'team.join_link.reset':
      return { group: 'Team', verb: 'reset the join link' };

    // AI
    case 'ai.file.drafted':
      return { group: 'AI', verb: 'drafted', object: file(m), details: [version(m)] };
    case 'ai.gate.requested':
      return {
        group: 'AI',
        verb: 'requested gate',
        object: gate(m),
        details: [
          num(m.required) !== null ? `needs ${plural(num(m.required) ?? 1, 'approval')}` : null,
        ],
      };
    case 'ai.tool.denied':
      return {
        group: 'AI',
        verb: 'was refused a tool',
        object: bold(md(m.tool ?? '?', 60)),
        details: [str(m.code) ? md(m.code, 40) : null],
      };

    // Settings
    case 'arena.created':
      return { group: 'Settings', verb: 'created the arena', object: bold(md(m.name ?? '?', 80)) };
    case 'arena.updated':
      return m.renamed === true
        ? { group: 'Settings', verb: 'renamed the arena to', object: bold(md(m.name ?? '?', 80)) }
        : { group: 'Settings', verb: 'changed the arena description' };
    case 'arena.archived':
      return { group: 'Settings', verb: 'archived the arena' };
    case 'arena.unarchived':
      return { group: 'Settings', verb: 'unarchived the arena' };
    case 'arena.ai_key.set':
      return {
        group: 'Settings',
        verb: 'set the arena’s AI key',
        object: bold(md(m.provider ?? '?', 40)),
        details: [str(m.model) ? md(m.model, 80) : null],
      };
    case 'arena.ai_key.removed':
      return { group: 'Settings', verb: 'removed the arena’s AI key' };
    default:
      return { group: groupOf(e.action), verb: md(e.action, 60) };
  }
}

function groupOf(action: string): ActivityGroup {
  const area = action.split('.')[0];
  if (area === 'loop') return 'Loop';
  if (area === 'repo') return 'Code';
  if (area === 'file') return 'Files';
  if (area === 'team') return 'Team';
  if (area === 'ai') return 'AI';
  return 'Settings';
}

/** "Asha (Owner, QA)", "AI", "GitHub · ravi-gh", "ParallelFlow". */
export function actorLabel(e: ActivityEvent): string {
  if (e.actorType === 'agent') return 'AI';
  if (e.actorType === 'service') {
    return md(str(e.metadata.actor_label) ?? 'ParallelFlow', 60);
  }
  const name = md(e.actorName ?? 'A former teammate', 60);
  return e.actorRoles.length ? `${name} (${e.actorRoles.map((r) => md(r, 30)).join(', ')})` : name;
}

/** "14:02" (UTC). */
const clock = (iso: string): string => new Date(iso).toISOString().slice(11, 16);
/** "2026-11-03" (UTC). */
export const utcDay = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

/** One event as its markdown line(s). */
export function eventLine(e: ActivityEvent): string {
  const d = describe(e);
  const parts = [
    clock(e.at),
    actorLabel(e),
    d.verb,
    d.object ?? null,
    ...(d.details ?? []),
    `\`evt-${e.id}\``,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  const line = `- ${parts.join(' · ')}`;
  return [line, ...(d.children ?? []).map((c) => `  - ${c}`)].join('\n');
}

/** Newest first: time, then id (the chain's order). */
function newestFirst(a: ActivityEvent, b: ActivityEvent): number {
  const t = Date.parse(b.at) - Date.parse(a.at);
  if (t !== 0) return t;
  return Number(BigInt(b.id) - BigInt(a.id));
}

/** The day sections ("## yyyy-mm-dd" … ), newest day first. */
export function renderDays(events: readonly ActivityEvent[]): string[] {
  const byDay = new Map<string, ActivityEvent[]>();
  for (const e of [...events].sort(newestFirst)) {
    const day = utcDay(e.at);
    const list = byDay.get(day) ?? [];
    list.push(e);
    byDay.set(day, list);
  }
  const out: string[] = [];
  for (const [day, list] of byDay) {
    const lines = [`## ${day}`];
    for (const group of GROUP_ORDER) {
      const inGroup = list.filter((e) => describe(e).group === group);
      if (!inGroup.length) continue;
      lines.push('', `### ${group}`, ...inGroup.map(eventLine));
    }
    out.push(lines.join('\n'));
  }
  return out;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "2026-10" → "October 2026". */
export function monthName(month: string): string {
  const [y, m] = month.split('-');
  return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

/** The first day kept in PROGRESS.md for `today`. */
export function cutoffDay(today: string, days = ACTIVITY_DAYS): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().slice(0, 10);
}

function nowTable(now: ActivityNow): string {
  const waiting = now.gate
    ? `Gate: ${md(stageName(now.gate.stage))} → ${now.gate.to ? md(stageName(now.gate.to)) : 'next'} (${now.gate.approvals}/${now.gate.required})`
    : 'Nothing';
  return [
    '| Cycle | Stage | Waiting on | Members | Open PRs |',
    '|---|---|---|---|---|',
    `| ${now.cycle ?? '–'} | ${now.stage ? md(stageName(now.stage)) : '–'} | ${waiting} | ${now.members} | ${now.openPulls} |`,
  ].join('\n');
}

/** PROGRESS.md and its monthly archives. */
export function renderActivity(input: ActivityInput): ActivityFiles {
  const name = md(input.arenaName, 120);
  const cutoff = cutoffDay(input.today);
  const recent = input.events.filter((e) => utcDay(e.at) >= cutoff);
  const older = input.events.filter((e) => utcDay(e.at) < cutoff);

  const byMonth = new Map<string, ActivityEvent[]>();
  for (const e of older) {
    const month = utcDay(e.at).slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(e);
    byMonth.set(month, list);
  }
  const months = [...byMonth.keys()].sort().reverse();
  const archives = months.map((month) => ({
    month,
    path: `${ARCHIVE_DIR}/${month}.md`,
    content: [
      `${ACTIVITY_TITLE_PREFIX}${name} · ${monthName(month)}`,
      '',
      `> Older activity of this arena, recorded by ParallelFlow. Times in UTC. Do not edit. The latest is in [PROGRESS.md](../../PROGRESS.md).`,
      '',
      ...renderDays(byMonth.get(month) ?? []).flatMap((d) => [d, '']),
    ].join('\n'),
  }));

  const days = renderDays(recent);
  const earlier = [
    ...archives.map((a) => `- [${monthName(a.month)}](${a.path})`),
    ...(input.hasLegacy ? [`- [The log in its earlier format](${ARCHIVE_DIR}/legacy.md)`] : []),
  ];
  const progress = [
    `${ACTIVITY_TITLE_PREFIX}${name}`,
    '',
    `> Every change to this arena, recorded by ParallelFlow from its event stream. Times in UTC. Do not edit: ParallelFlow rewrites this file. What the team discussed and decided is in [STATE.md](STATE.md).`,
    '',
    '## Now',
    '',
    nowTable(input.now),
    '',
    ...(days.length
      ? days.flatMap((d) => [d, ''])
      : [`No activity in the last ${ACTIVITY_DAYS} days.`, '']),
    ...(earlier.length ? ['## Earlier', '', ...earlier, ''] : []),
  ].join('\n');
  return { progress, archives };
}

/** Is this PROGRESS.md content the activity log (not the older log formats)? */
export const isActivityLog = (content: string | null | undefined): boolean =>
  (content ?? '').startsWith(ACTIVITY_TITLE_PREFIX);
