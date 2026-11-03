import { describe, expect, it } from 'vitest';
import {
  type ActivityEvent,
  type ActivityInput,
  cutoffDay,
  eventLine,
  isActivityLog,
  md,
  renderActivity,
} from './activity-log.js';

let seq = 0;
function ev(at: string, action: string, over: Partial<ActivityEvent> = {}): ActivityEvent {
  seq += 1;
  return {
    id: String(seq),
    at,
    action,
    actorType: 'user',
    actorName: 'Asha',
    actorRoles: ['Owner'],
    targetName: null,
    metadata: {},
    ...over,
  };
}

const base = (events: ActivityEvent[], over: Partial<ActivityInput> = {}): ActivityInput => ({
  arenaName: 'TrackFlow',
  today: '2026-11-03',
  now: {
    cycle: 2,
    stage: 'BUILD',
    gate: { stage: 'BUILD', to: 'TEST', approvals: 1, required: 2 },
    members: 5,
    openPulls: 3,
  },
  events,
  ...over,
});

describe('activity log', () => {
  it('renders the title, the Now table and days newest first, groups in a fixed order', () => {
    const events = [
      ev('2026-11-02T09:00:00Z', 'team.member.joined', { actorName: 'Kiran', actorRoles: ['QA'] }),
      ev('2026-11-03T10:15:00Z', 'file.uploaded', {
        actorName: 'Meera',
        actorRoles: [],
        metadata: { name: 'wireframes.pdf', mime_type: 'application/pdf', size_bytes: 2048 },
      }),
      ev('2026-11-03T14:02:00Z', 'loop.gate.approved', {
        metadata: { stage: 'DESIGN', to: 'BUILD', approvals: 2, required: 2 },
      }),
      ev('2026-11-03T14:02:00Z', 'loop.stage.moved', {
        metadata: { cycle: 2, from: 'DESIGN', to: 'BUILD' },
      }),
      ev('2026-11-03T16:20:00Z', 'repo.pr.merged', {
        actorType: 'service',
        actorName: null,
        actorRoles: [],
        metadata: {
          number: 42,
          title: 'Checkout retry',
          sha: 'abcdef1234',
          actor_label: 'GitHub · ravi-gh',
        },
      }),
    ];
    const { progress, archives } = renderActivity(base(events));
    expect(archives).toEqual([]);
    expect(isActivityLog(progress)).toBe(true);
    expect(progress.startsWith('# Activity log: TrackFlow\n')).toBe(true);
    expect(progress).toContain('| 2 | Build | Gate: Build → Test (1/2) | 5 | 3 |');

    const order = [
      '## 2026-11-03',
      '### Loop',
      '### Code',
      '### Files',
      '## 2026-11-02',
      '### Team',
    ];
    const at = order.map((h) => progress.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);

    // Same minute: the later event (higher id) first.
    expect(progress.indexOf('moved the stage')).toBeLessThan(progress.indexOf('approved gate'));
    expect(progress).toContain(
      '- 14:02 · Asha (Owner) · approved gate · **Design → Build** · 2/2 approvals · `evt-3`',
    );
    expect(progress).toContain(
      'GitHub · ravi-gh · merged · **PR #42** · *Checkout retry* · `abcdef1`',
    );
    expect(progress).toContain('Meera · uploaded · **wireframes.pdf** · application/pdf · 2 KB');
    expect(progress).toContain('Kiran (QA) · joined the arena');
  });

  it('moves days older than 60 into monthly archives, newest month first, and links them', () => {
    expect(cutoffDay('2026-11-03')).toBe('2026-09-05');
    const events = [
      ev('2026-11-01T08:00:00Z', 'file.created', { metadata: { name: 'plan.md', version: 1 } }),
      ev('2026-09-04T08:00:00Z', 'file.created', { metadata: { name: 'old-a.md', version: 1 } }),
      ev('2026-08-20T08:00:00Z', 'file.created', { metadata: { name: 'old-b.md', version: 1 } }),
    ];
    const { progress, archives } = renderActivity(base(events, { hasLegacy: true }));
    expect(archives.map((a) => a.path)).toEqual([
      'docs/progress/2026-09.md',
      'docs/progress/2026-08.md',
    ]);
    expect(archives[0]?.content).toContain('old-a.md');
    expect(archives[0]?.content).not.toContain('old-b.md');
    expect(progress).toContain('plan.md');
    expect(progress).not.toContain('old-a.md');
    expect(progress).toContain('- [September 2026](docs/progress/2026-09.md)');
    expect(progress).toContain('(docs/progress/legacy.md)');
  });

  it('prints only the fields it knows, escaped: no content can ride along in metadata', () => {
    const line = eventLine(
      ev('2026-11-03T12:00:00Z', 'file.version_added', {
        actorName: 'Eve | *admin*',
        metadata: {
          name: 'notes`.md\n# injected',
          version: 3,
          body: 'THE DOCUMENT TEXT',
          content: 'more text',
        },
      }),
    );
    expect(line).not.toContain('THE DOCUMENT TEXT');
    expect(line).not.toContain('more text');
    expect(line).toContain('Eve \\| \\*admin\\*');
    expect(line).toContain('**notes\\`.md \\# injected**');
    expect(line.split('\n')).toHaveLength(1);
    // An unknown action still gets a line, without its metadata.
    const unknown = eventLine(
      ev('2026-11-03T12:00:00Z', 'future.thing', { metadata: { secret: 'x' } }),
    );
    expect(unknown).toContain('future.thing');
    expect(unknown).not.toContain('secret');
  });

  it('names the AI and services, lists pushed commits, and is deterministic', () => {
    const events = [
      ev('2026-11-03T09:00:00Z', 'ai.file.drafted', {
        actorType: 'agent',
        actorName: null,
        actorRoles: [],
        metadata: { name: 'hld.md', version: 2 },
      }),
      ev('2026-11-03T09:30:00Z', 'repo.commit.pushed', {
        actorType: 'service',
        actorName: null,
        actorRoles: [],
        metadata: { count: 2, branch: 'main', sha: '1234567', commits: ['Add login', 'Fix tests'] },
      }),
    ];
    const a = renderActivity(base(events));
    const b = renderActivity(base([...events].reverse()));
    expect(a).toEqual(b);
    expect(a.progress).toContain('- 09:00 · AI · drafted · **hld.md** · v2');
    expect(a.progress).toContain(
      '- 09:30 · ParallelFlow · pushed · **2 commits** · to main · `1234567`',
    );
    expect(a.progress).toContain('\n  - Add login\n  - Fix tests');
  });

  it('says so when nothing happened, and escapes table cells', () => {
    const { progress } = renderActivity(
      base([], {
        arenaName: 'A|B',
        now: { cycle: null, stage: null, gate: null, members: 1, openPulls: 0 },
      }),
    );
    expect(progress).toContain('# Activity log: A\\|B');
    expect(progress).toContain('| – | – | Nothing | 1 | 0 |');
    expect(progress).toContain('No activity in the last 60 days.');
    expect(md('a'.repeat(200), 10)).toHaveLength(10);
  });
});
