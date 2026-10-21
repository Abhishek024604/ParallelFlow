import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { approveGate, overridePhase } from './approve.js';
import { createSwaExtension, insideArch, SWA_TOOL_NAMES } from './extension.js';
import { classifyPath, normalizeArchPath } from './layout.js';
import {
  contentHash,
  LOCK_CLOSE,
  LOCK_OPEN,
  lockedBlockViolation,
  readFrontmatter,
  replaceSection,
} from './markdown.js';
import { swaResources } from './resources.js';
import { canStart, parseGate, renderStatus, snapshot } from './state.js';
import { FsArchStore, MemoryArchStore } from './store.js';
import { governanceCheck, renderGovernance } from './governance.js';
import { validate } from './validate.js';
import { planWrite } from './writes.js';

const md = (id: string, body = 'Text.', extra = '') =>
  `---\nid: ${id}\nstatus: draft\nversion: 1\nowner: architect\ninputs: [inputs/srs.md]\n${extra}---\n\n# ${id}\n\n${body}\n`;

const withInputs = (extra: Record<string, string> = {}) =>
  new MemoryArchStore({
    'inputs/srs.md': '# SRS\nFR-1 Users sign in.',
    'inputs/goal.md': '# Goals',
    ...extra,
  });

async function write(store: MemoryArchStore, path: string, content: string, section?: string) {
  const plan = await planWrite(store, await snapshot(store), {
    path,
    content,
    ...(section && { section }),
  });
  if (plan.ok) await store.write(plan.path, plan.text);
  return plan;
}

describe('arch/ paths', () => {
  it('normalizes paths and refuses ones that leave arch/', () => {
    expect(normalizeArchPath('arch/stack.md')).toBe('stack.md');
    expect(normalizeArchPath('./hld\\hld.md')).toBe('hld/hld.md');
    for (const bad of ['../x.md', '/etc/passwd', 'C:/x', 'a//b', 'hld/../../x', '']) {
      expect(normalizeArchPath(bad)).toBeNull();
    }
  });

  it('knows every path of the layout', () => {
    expect(classifyPath('00-drivers.md')).toEqual({ kind: 'artifact', phase: 'intake' });
    expect(classifyPath('decisions/ADR-0001-architecture-style.md')).toMatchObject({
      phase: 'adr',
    });
    expect(classifyPath('lld/CMP-003/sequence-login.drawio')).toEqual({
      kind: 'artifact',
      phase: 'lld',
      component: 'CMP-003',
    });
    expect(classifyPath('inputs/srs.md').kind).toBe('input');
    expect(classifyPath('.swa/state.json').kind).toBe('state');
    expect(classifyPath('notes.md').kind).toBe('unknown');
  });

  it('spots Pi file tools aimed at arch/', () => {
    expect(insideArch('/repo', 'arch/stack.md')).toBe(true);
    expect(insideArch('/repo', '@arch/x')).toBe(true);
    expect(insideArch('/repo', 'src/arch.ts')).toBe(false);
    expect(insideArch('/repo', 'archive/x')).toBe(false);
  });
});

describe('markdown rules', () => {
  it('reads YAML frontmatter and reports a broken one', () => {
    expect(readFrontmatter(md('STACK')).data).toMatchObject({ id: 'STACK', version: 1 });
    expect(readFrontmatter('---\n[a, b]\n---\nx').error).toContain('not a YAML mapping');
    expect(readFrontmatter('no frontmatter').data).toEqual({});
  });

  it('hashes CRLF and LF text the same', () => {
    expect(contentHash('a\r\nb\r\n')).toBe(contentHash('a\nb\n'));
  });

  it('keeps locked blocks exactly', () => {
    const before = `intro\n${LOCK_OPEN}\nThe architect's words.\n${LOCK_CLOSE}\nmore`;
    expect(lockedBlockViolation(before, before.replace('intro', 'Intro'))).toBeNull();
    expect(lockedBlockViolation(before, before.replace("architect's", 'agent'))).toContain(
      'locked block 1 of 1',
    );
    expect(lockedBlockViolation(before, 'intro')).toContain('removes');
    expect(lockedBlockViolation('x', `${LOCK_OPEN}\nmine`)).toContain('adds a locked block');
  });

  it('replaces one section and leaves the rest', () => {
    const text = '# T\n\n## Scope\n\nold\n\n### Detail\n\nd\n\n## Risks\n\nr\n';
    const out = replaceSection(text, '## scope', 'new body');
    expect(out).toEqual({ text: '# T\n\n## Scope\n\nnew body\n\n## Risks\n\nr\n' });
    expect(replaceSection(text, 'Missing', 'x')).toEqual({
      error: 'there is no section "Missing"',
    });
  });
});

describe('gates and phase rules', () => {
  it('needs the SRS and goal.md before anything starts', async () => {
    const snap = await snapshot(new MemoryArchStore());
    const start = canStart(snap, 'intake');
    expect(start.ok).toBe(false);
    expect(renderStatus(snap)).toContain('missing: srs.md, goal.md');
  });

  it('runs intake, then holds stack until G0 is approved by the architect', async () => {
    const store = withInputs();
    expect((await write(store, 'arch/00-drivers.md', md('DRIVERS'))).ok).toBe(true);
    const blocked = await write(store, 'stack.md', md('STACK'));
    expect(blocked).toMatchObject({ ok: false });
    expect(!blocked.ok && blocked.error).toContain('/swa approve G0');

    expect((await approveGate(store, 'g0', 'Asha')).ok).toBe(true);
    expect(store.files.get('00-drivers.md')).toContain('status: approved');
    expect((await snapshot(store)).gates[0]).toMatchObject({ gate: 'G0', state: 'approved' });
    expect((await write(store, 'stack.md', md('STACK'))).ok).toBe(true);
  });

  it('reopens a gate when an approved file changes, and never lets the agent approve', async () => {
    const store = withInputs({ '00-drivers.md': md('DRIVERS') });
    await approveGate(store, 'G0', 'Asha');
    const plan = await write(
      store,
      '00-drivers.md',
      md('DRIVERS', 'Edited.').replace('status: draft', 'status: approved'),
    );
    expect(plan.ok && plan.notes.join(' ')).toContain('only the architect approves');
    expect(plan.ok && plan.notes.join(' ')).toContain('G0 is open again');
    expect(store.files.get('00-drivers.md')).toContain('status: draft');
    const snap = await snapshot(store);
    expect(snap.files[0]?.state).toBe('changed');
    expect(snap.gates[0]?.state).toBe('open');
  });

  it('refuses inputs, approvals, locked blocks and paths outside the layout', async () => {
    const locked = `${md('DRIVERS')}${LOCK_OPEN}\nKeep.\n${LOCK_CLOSE}\n`;
    const store = withInputs({ '00-drivers.md': locked });
    expect(await write(store, 'inputs/srs.md', 'changed')).toMatchObject({ ok: false });
    expect(await write(store, 'inputs/meeting-summary.md', 'notes')).toMatchObject({ ok: true });
    expect(await write(store, '.swa/state.json', '{}')).toMatchObject({ ok: false });
    expect(await write(store, 'notes.md', 'x')).toMatchObject({ ok: false });
    expect(await write(store, '../src/x.ts', 'x')).toMatchObject({ ok: false });
    expect(await write(store, '00-drivers.md', md('DRIVERS'))).toMatchObject({ ok: false });
    expect(await write(store, '00-drivers.md', 'New intro.', 'DRIVERS')).toMatchObject({
      ok: false,
    });
  });

  it('approves gates in order, and lets the architect override', async () => {
    const store = withInputs({ '00-drivers.md': md('DRIVERS') });
    expect((await approveGate(store, 'G1', 'Asha')).message).toContain('no files yet');
    expect((await write(store, 'stack.md', md('STACK'))).ok).toBe(false);
    expect((await overridePhase(store, 'stack', 'Asha')).ok).toBe(true);
    expect((await write(store, 'stack.md', md('STACK'))).ok).toBe(true);
    expect((await approveGate(store, 'G1', 'Asha')).message).toBe(
      'Approve G0 first: G1 builds on it.',
    );
    expect(parseGate('G3 cmp-003')).toEqual({ gate: 'G3', component: 'CMP-003' });
    expect(parseGate('G3')).toBeNull();
  });

  it('marks G2 as the baseline and gates LLD per component', async () => {
    const store = withInputs({
      '00-drivers.md': md('DRIVERS'),
      'stack.md': md('STACK'),
      'decisions/ADR-0001-architecture-style.md': md('ADR-0001'),
      'model.yaml': 'components: []\n',
      'hld/hld.md': md('HLD'),
    });
    await approveGate(store, 'G0', 'A');
    await approveGate(store, 'G1', 'A');
    expect((await approveGate(store, 'G2', 'A')).message).toContain('reviews/hld-review.md');
    await write(store, 'reviews/hld-review.md', md('HLD-REVIEW'));
    const g2 = await approveGate(store, 'G2', 'A');
    expect(g2).toMatchObject({ ok: true, baseline: true });
    expect(store.baselines).toHaveLength(1);
    expect(canStart(await snapshot(store), 'lld')).toMatchObject({ ok: false });
    expect(canStart(await snapshot(store), 'lld', 'CMP-003')).toEqual({ ok: true });
  });
});

describe('files host', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('keeps arch/ on disk with approvals in .swa/state.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swa-'));
    dirs.push(root);
    mkdirSync(join(root, 'arch', 'inputs'), { recursive: true });
    writeFileSync(join(root, 'arch', 'inputs', 'srs.md'), '# SRS');
    const store = new FsArchStore(root);
    await store.write('inputs/goal.md', '# Goals');
    await store.write('00-drivers.md', md('DRIVERS'));
    expect(await store.list()).toEqual(['00-drivers.md', 'inputs/goal.md', 'inputs/srs.md']);
    await approveGate(store, 'G0', 'architect');
    const state = JSON.parse(readFileSync(join(root, 'arch', '.swa', 'state.json'), 'utf8'));
    expect(state.approvals['00-drivers.md'].gate).toBe('G0');
    expect(await store.list()).not.toContain('.swa/state.json');
    await expect(store.read('../package.json')).rejects.toThrow('outside arch/');
  });
});

/** Just enough of Pi's surface for the extension's registrations. */
function fakePi(prompts: string[] = []) {
  type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
      tools.set(tool.name, tool),
    registerCommand: (name: string, c: { handler: (a: string, ctx: unknown) => Promise<void> }) =>
      commands.set(name, c),
    getCommands: () => prompts.map((name) => ({ name, source: 'prompt' })),
    sendUserMessage: (text: string) => sent.push(text),
    exec: async () => ({ stdout: '', stderr: '', code: 1, killed: false }),
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, commands, sent };
}

describe('the extension', () => {
  const notes: string[] = [];
  const ctx = {
    cwd: '/repo',
    isIdle: () => true,
    ui: { notify: (text: string) => notes.push(text) },
  };

  it('adds the rules and the status to the system prompt, and its three tools', async () => {
    const store = withInputs();
    const fake = fakePi();
    await createSwaExtension({ store: () => store })(fake.pi);
    expect([...fake.tools.keys()]).toEqual([...SWA_TOOL_NAMES]);
    const sections: Record<string, string> = {};
    for (const h of fake.handlers.get('before_agent_start') ?? []) {
      await h({ systemPromptOptions: { sections } }, ctx);
    }
    expect(sections['swa']).toContain('Only the architect approves a gate');
    expect(sections['swa_status']).toContain('Next: Run /swa intake.');
  });

  it('blocks Pi file tools in arch/ and refuses forbidden swa_write calls', async () => {
    const store = withInputs();
    const fake = fakePi();
    await createSwaExtension({ store: () => store })(fake.pi);
    const [guard] = fake.handlers.get('tool_call') ?? [];
    expect(guard?.({ toolName: 'edit', input: { path: 'arch/stack.md' } }, ctx)).toMatchObject({
      block: true,
    });
    expect(guard?.({ toolName: 'edit', input: { path: 'src/a.ts' } }, ctx)).toBeUndefined();
    const swaWrite = fake.tools.get('swa_write');
    await expect(
      swaWrite?.execute('1', { path: 'stack.md', content: md('STACK') }, undefined, undefined, ctx),
    ).rejects.toThrow('REFUSED');
  });

  it('answers /swa status and approve itself, and runs a phase prompt only past its gates', async () => {
    notes.length = 0;
    const store = withInputs();
    const fake = fakePi(['swa-intake']);
    await createSwaExtension({ store: () => store })(fake.pi);
    const swa = fake.commands.get('swa');
    await swa?.handler('status', ctx);
    expect(notes.pop()).toContain('SWA status');
    await swa?.handler('stack', ctx);
    expect(notes.pop()).toContain('needs gate G0 approved first');
    await swa?.handler('intake focus on payments', ctx);
    expect(fake.sent).toEqual(['/swa-intake focus on payments']);
    await swa?.handler('hld', ctx);
    expect(notes.pop()).toContain('needs gate G1');
  });

  it('ships its system prompt and input templates', () => {
    const r = swaResources();
    expect(r.systemPrompt).toContain('# SWA');
    expect(r.template('goal.md')).toContain('## Quality priorities');
    expect(r.template('governance.default.yaml')).toContain('forbidden:');
  });
});

describe('validation and governance', () => {
  const drivers = md(
    'DRIVERS',
    '| ID | Requirement |\n| --- | --- |\n| FR-001 | Sign in |\n| NFR-001 | p95 < 300 ms |\n| FR-001 | Again |',
  );

  it('reports missing frontmatter, duplicate IDs and citations of unknown IDs', async () => {
    const store = withInputs({
      '00-drivers.md': drivers,
      'stack.md': '# Stack\nMeets FR-001 and FR-009 (ADR-0001).',
    });
    const problems = (await validate(store)).map((p) => `${p.path}: ${p.problem}`);
    expect(problems).toContain('00-drivers.md: FR-001 is defined 2 times');
    expect(problems.join('\n')).toContain('stack.md: no YAML frontmatter');
    expect(problems.join('\n')).toContain(
      'cites IDs that are not defined anywhere: ADR-0001, FR-009',
    );
  });

  it('hashes the inputs an artifact names when it is written', async () => {
    const store = withInputs();
    await write(store, '00-drivers.md', drivers.replace('FR-001 | Again', 'FR-002 | Again'));
    expect(store.files.get('00-drivers.md')).toMatch(
      /inputs:\n {2}- path: inputs\/srs\.md\n {4}hash: [0-9a-f]{16}/,
    );
  });

  it('checks the stack against the governance rules, and G1 waits for a clean check', async () => {
    const stack = md(
      'STACK',
      'Uses ADR-0001. SEC-TLS everywhere.',
      'stack:\n  - { layer: data, tech: PostgreSQL, adr: ADR-0001 }\n  - { layer: transfer, tech: ftp }\n',
    );
    const store = withInputs({
      '00-drivers.md': md('DRIVERS'),
      'stack.md': stack,
      'decisions/ADR-0001-architecture-style.md': md('ADR-0001'),
    });
    const report = await governanceCheck(store, swaResources());
    expect(report.forbidden).toEqual([{ tech: 'ftp', reason: expect.stringContaining('SFTP') }]);
    expect(report.unaddressed.map((u) => u.id)).toContain('SEC-SECRETS');
    expect(report.unaddressed.map((u) => u.id)).not.toContain('SEC-TLS');
    expect(renderGovernance(report)).toContain('FORBIDDEN: ftp');

    await approveGate(store, 'G0', 'A', swaResources());
    const g1 = await approveGate(store, 'G1', 'A', swaResources());
    expect(g1).toMatchObject({ ok: false });
    expect(g1.message).toContain('FORBIDDEN: ftp');
    store.files.set('stack.md', stack.replace('  - { layer: transfer, tech: ftp }\n', ''));
    expect(await approveGate(store, 'G1', 'A', swaResources())).toMatchObject({ ok: true });
  });

  it('a company governance file replaces the default pack', async () => {
    const store = withInputs({
      'inputs/governance.yaml': 'technology:\n  allowed: [PostgreSQL]\n  required: [Kubernetes]\n',
      'stack.md': md('STACK', '', 'stack:\n  - { layer: data, tech: MySQL }\n'),
    });
    const report = await governanceCheck(store, swaResources());
    expect(report.source).toBe('arch/inputs/governance.yaml');
    expect(report.notAllowed).toEqual(['MySQL']);
    expect(report.requiredMissing).toEqual(['Kubernetes']);
    expect(report.unaddressed).toEqual([]);
  });

  it('gives the model the templates through swa_read', async () => {
    const fake = fakePi();
    await createSwaExtension({ store: () => withInputs() })(fake.pi);
    const read = fake.tools.get('swa_read');
    const out = (await read?.execute('1', { template: 'stack.md' }, undefined, undefined, {
      cwd: '/repo',
    })) as { content: { text: string }[] };
    expect(out.content[0]?.text).toContain('## Architecture style');
  });

  it('ships a skill and a command for each built phase', () => {
    const r = swaResources();
    const names = (paths: string[]) => paths.map((p) => basename(p));
    expect(names(r.skills)).toEqual(['swa-adr', 'swa-intake', 'swa-stack']);
    expect(names(r.prompts)).toEqual(['swa-adr.md', 'swa-intake.md', 'swa-stack.md']);
  });
});
