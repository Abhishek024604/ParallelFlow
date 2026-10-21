import { isAbsolute, relative, resolve } from 'node:path';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { approveGate, overridePhase } from './approve.js';
import { CMP_ID, isPhaseId, normalizeArchPath, type PhaseId } from './layout.js';
import { initInputs, type SwaResources, swaResources } from './resources.js';
import { canStart, renderStatus, snapshot } from './state.js';
import { type ArchStore, FsArchStore } from './store.js';
import { governanceCheck, renderGovernance } from './governance.js';
import { modelComponents, renderProblems, validate } from './validate.js';
import { saveDiagrams, type SaveRequest, syncDiagram } from './diagram-tools.js';
import { impact, markStale, renderImpact } from './impact.js';
import { checkLld, renderLldCheck } from './lld.js';
import { renderTrace, trace } from './trace.js';
import { planWrite } from './writes.js';

// The SWA Pi extension (docs/15_SWA_Extension.md). One factory call per Pi session.
//
//   before_agent_start → the SWA rules (SYSTEM.md) and the current status as system prompt sections
//   swa_status, swa_read, swa_write → the model's only way into arch/ (writes.ts enforces the rules)
//   tool_call          → files host: Pi's own write/edit tools may not touch arch/
//   /swa               → the architect's command: status, init, approve, override (no model), and
//                        the phase commands, which check the gates and then run the phase prompt

export const SWA_STATUS = 'swa_status';
export const SWA_READ = 'swa_read';
export const SWA_WRITE = 'swa_write';
export const SWA_VALIDATE = 'swa_validate';
export const SWA_GOVERNANCE = 'swa_governance_check';
export const SWA_TRACE = 'swa_trace';
export const SWA_DIAGRAM_SAVE = 'swa_diagram_save';
export const SWA_DIAGRAM_SYNC = 'swa_diagram_sync';
export const SWA_LLD_CHECK = 'swa_lld_check';
export const SWA_IMPACT = 'swa_impact';
/** The extension's tools: hosts that pass a tool allowlist to Pi must include these. */
export const SWA_TOOL_NAMES = [
  SWA_STATUS,
  SWA_READ,
  SWA_WRITE,
  SWA_VALIDATE,
  SWA_GOVERNANCE,
  SWA_TRACE,
  SWA_DIAGRAM_SAVE,
  SWA_DIAGRAM_SYNC,
  SWA_LLD_CHECK,
  SWA_IMPACT,
] as const;

export interface SwaExtensionOptions {
  /** Where arch/ lives. Default: arch/ on disk under the session's cwd. */
  store?: (cwd: string) => ArchStore;
  /** The package files (a bundling host passes the folder it copied them to). */
  resources?: SwaResources;
  /** Who approves on this host (recorded with each approval). */
  architect?: string;
  /** Block Pi's own write/edit tools inside arch/ (files host; default on). */
  guardFileTools?: boolean;
  /** Register /swa (default on). Off where the host has its own commands (the arena). */
  command?: boolean;
  /** TypeBox `Type`, for hosts that load this through Pi's extension loader (static imports only). */
  typebox?: typeof import('@earendil-works/pi-ai').Type;
}

const MAX_READ = 200_000;

/** Templates the model may read (templates/). */
export const TEMPLATES = [
  'drivers.md',
  'stack.md',
  'adr.md',
  'model.yaml',
  'hld.md',
  'hld-review.md',
  'risks.md',
  'lld.md',
  'goal.md',
  'governance.default.yaml',
] as const;

const HELP = `SWA commands
/swa status                 where the project stands
/swa init                   create arch/inputs/goal.md and governance.yaml to fill in
/swa intake | stack | hld | review-design | review-code | impact
/swa lld CMP-003            the LLD of one component
/swa adr <title>            record one decision
/swa approve G0|G1|G2|G3:CMP-003   approve a gate (only you can)
/swa override <phase>       let a phase start before its gates are approved`;

/** The phase a /swa sub-command runs, for the gate check. */
const COMMAND_PHASE: Record<string, PhaseId> = {
  intake: 'intake',
  stack: 'stack',
  hld: 'hld',
  'review-design': 'review-design',
  lld: 'lld',
  'review-code': 'review-code',
  impact: 'impact',
  adr: 'stack',
};

/** True when `file` (as the model gave it) is inside <cwd>/arch. */
export function insideArch(cwd: string, file: string): boolean {
  const root = resolve(cwd, 'arch');
  const target = resolve(cwd, file.replace(/^@/, ''));
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function createSwaExtension(options: SwaExtensionOptions = {}): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const Type = options.typebox ?? (await import('@earendil-works/pi-ai')).Type;
    const resources = options.resources ?? swaResources();
    const makeStore = options.store ?? ((cwd: string) => new FsArchStore(cwd));
    const stores = new Map<string, ArchStore>();
    const storeFor = (ctx: ExtensionContext): ArchStore => {
      let store = stores.get(ctx.cwd);
      if (!store) {
        store = makeStore(ctx.cwd);
        stores.set(ctx.cwd, store);
      }
      return store;
    };
    const architect = options.architect ?? 'architect';

    pi.on('before_agent_start', async (event, ctx) => {
      const sections = event.systemPromptOptions.sections;
      sections['swa'] = resources.systemPrompt;
      try {
        sections['swa_status'] = renderStatus(await snapshot(storeFor(ctx)));
      } catch {
        sections['swa_status'] = 'Status unavailable: call swa_status.';
      }
    });

    if (options.guardFileTools !== false) {
      pi.on('tool_call', (event, ctx) => {
        if (event.toolName !== 'write' && event.toolName !== 'edit') return;
        const file = (event.input as { path?: unknown }).path;
        if (typeof file === 'string' && insideArch(ctx.cwd, file)) {
          return {
            block: true,
            reason:
              'arch/ is written with swa_write only (it keeps inputs, locked blocks and gates safe).',
          };
        }
      });
    }

    pi.registerTool({
      name: SWA_STATUS,
      label: 'SWA status',
      description:
        'Where the architecture work stands: inputs, every gate (G0-G3) and its files (approved, draft, changed since approval, stale), and the next step. Call it before starting a phase.',
      parameters: Type.Unsafe<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async (_id, _params, _signal, _onUpdate, ctx) => ({
        content: [{ type: 'text', text: renderStatus(await snapshot(storeFor(ctx))) }],
        details: {},
      }),
    });

    pi.registerTool({
      name: SWA_READ,
      label: 'SWA read',
      description:
        'Read one file in arch/ (path relative to arch/, e.g. "inputs/srs.md", "stack.md", "decisions/ADR-0001-architecture-style.md"), or with `template` one of the SWA templates to start an artifact from: ' +
        TEMPLATES.join(', ') +
        '.',
      parameters: Type.Unsafe<{ path?: string; template?: string }>({
        type: 'object',
        properties: {
          path: { type: 'string' },
          template: { type: 'string', enum: [...TEMPLATES] },
        },
        additionalProperties: false,
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const template = (params as { template?: unknown }).template;
        if (typeof template === 'string' && template) {
          if (!(TEMPLATES as readonly string[]).includes(template)) {
            throw new Error(
              `NOT_FOUND: no template "${template}". Templates: ${TEMPLATES.join(', ')}`,
            );
          }
          return {
            content: [{ type: 'text', text: resources.template(template) }],
            details: { template },
          };
        }
        const raw = String((params as { path?: unknown }).path ?? '');
        const path = normalizeArchPath(raw);
        if (!path) throw new Error(`INVALID_ARGS: "${raw}" is not a path inside arch/`);
        const text = await storeFor(ctx).read(path);
        if (text === null)
          throw new Error(`NOT_FOUND: arch/${path} does not exist (swa_status lists the files)`);
        const cut = text.length > MAX_READ;
        return {
          content: [
            {
              type: 'text',
              text: cut
                ? `${text.slice(0, MAX_READ)}\n\n[truncated: the file is ${text.length} characters]`
                : text,
            },
          ],
          details: { path },
        };
      },
    });

    pi.registerTool({
      name: SWA_WRITE,
      label: 'SWA write',
      description:
        'Create or update a file in arch/ (path relative to arch/). Give the whole text, or `section` (a heading, e.g. "Quality scenarios") with the new body of just that section. Refuses writes the SWA rules forbid: inputs, approvals, locked blocks, paths outside the layout, and phases whose gates are not approved.',
      parameters: Type.Unsafe<{ path: string; content: string; section?: string }>({
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
          section: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      }),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const p = params as { path?: unknown; content?: unknown; section?: unknown };
        const store = storeFor(ctx);
        const plan = await planWrite(store, await snapshot(store), {
          path: String(p.path ?? ''),
          content: String(p.content ?? ''),
          ...(typeof p.section === 'string' && p.section.trim() && { section: p.section }),
        });
        if (!plan.ok) throw new Error(`REFUSED: ${plan.error}`);
        await store.write(plan.path, plan.text);
        return {
          content: [
            {
              type: 'text',
              text: [
                `${plan.created ? 'Created' : 'Updated'} arch/${plan.path}.`,
                ...plan.notes,
              ].join(' '),
            },
          ],
          details: { path: plan.path, created: plan.created },
        };
      },
    });

    pi.registerTool({
      name: SWA_VALIDATE,
      label: 'SWA validate',
      description:
        'Check arch/ artifacts: frontmatter (id, status, version, owner, inputs), duplicate requirement IDs, and cited IDs (FR, NFR, CON, CMP, ADR) that are not defined anywhere. Give a path to check one file; leave it out to check all. Run it before telling the architect a phase is ready for approval.',
      parameters: Type.Unsafe<{ path?: string }>({
        type: 'object',
        properties: { path: { type: 'string' } },
        additionalProperties: false,
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const raw = (params as { path?: unknown }).path;
        const path = typeof raw === 'string' && raw.trim() ? normalizeArchPath(raw) : undefined;
        if (path === null)
          throw new Error(`INVALID_ARGS: "${String(raw)}" is not a path inside arch/`);
        const problems = await validate(storeFor(ctx), path ? [path] : undefined);
        return {
          content: [{ type: 'text', text: renderProblems(problems) }],
          details: { problems: problems.length },
        };
      },
    });

    pi.registerTool({
      name: SWA_GOVERNANCE,
      label: 'SWA governance',
      description:
        "Check arch/stack.md's `stack` list against the governance rules (arch/inputs/governance.yaml, else the default pack): forbidden, not-allowed and missing required technology, and rules stack.md does not address yet. G1 can't be approved while it reports violations.",
      parameters: Type.Unsafe<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async (_id, _params, _signal, _onUpdate, ctx) => ({
        content: [
          { type: 'text', text: renderGovernance(await governanceCheck(storeFor(ctx), resources)) },
        ],
        details: {},
      }),
    });

    pi.registerTool({
      name: SWA_TRACE,
      label: 'SWA trace',
      description:
        'The traceability matrix: each requirement (FR, NFR, CON from 00-drivers.md) → the components that satisfy it (model.yaml) → their ADRs → code paths, with the gaps (unsatisfied requirements, components that satisfy nothing, undefined ids).',
      parameters: Type.Unsafe<Record<string, never>>({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      execute: async (_id, _params, _signal, _onUpdate, ctx) => ({
        content: [{ type: 'text', text: renderTrace(await trace(storeFor(ctx))) }],
        details: {},
      }),
    });

    pi.registerTool({
      name: SWA_DIAGRAM_SAVE,
      label: 'SWA diagrams',
      description:
        'Generate the HLD diagrams from arch/model.yaml and save them in arch/hld/: context, containers, deployment and one per flow (leave `view` out for all). format "drawio" (default) for the HLD; "excalidraw" for a whiteboard sketch in hld/sketches/. A diagram the architect edited is kept and its differences from the model are reported; `replace: true` overwrites it, only when the architect said so.',
      parameters: Type.Unsafe<SaveRequest>({
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['context', 'containers', 'deployment', 'flow'] },
          flow: { type: 'string', description: 'The flow id, with view "flow".' },
          format: { type: 'string', enum: ['drawio', 'excalidraw'] },
          replace: { type: 'boolean' },
        },
        additionalProperties: false,
      }),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const text = await saveDiagrams(storeFor(ctx), params as SaveRequest);
        return { content: [{ type: 'text', text }], details: {} };
      },
    });

    pi.registerTool({
      name: SWA_DIAGRAM_SYNC,
      label: 'SWA diagram sync',
      description:
        'Read a .drawio file in arch/hld/ back (after the architect edited it in draw.io) and report how it differs from arch/model.yaml: missing, renamed or added shapes and connections. Changes nothing.',
      parameters: Type.Unsafe<{ path: string }>({
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => ({
        content: [
          {
            type: 'text',
            text: await syncDiagram(
              storeFor(ctx),
              String((params as { path?: unknown }).path ?? ''),
            ),
          },
        ],
        details: {},
      }),
    });

    pi.registerTool({
      name: SWA_LLD_CHECK,
      label: 'SWA LLD check',
      description:
        'Check one component\'s LLD against its neighbours in model.yaml: it publishes the contract they rely on (openapi.yaml for sync callers, asyncapi.yaml for events), mentions every neighbour, and every operation or event it uses (lines like "CMP-002 POST /orders" or "CMP-004 event OrderPlaced") exists in that neighbour\'s contract. G3 can\'t be approved while it reports problems.',
      parameters: Type.Unsafe<{ component: string }>({
        type: 'object',
        properties: { component: { type: 'string', description: 'e.g. CMP-003' } },
        required: ['component'],
        additionalProperties: false,
      }),
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const component = String((params as { component?: unknown }).component ?? '')
          .trim()
          .toUpperCase();
        if (!CMP_ID.test(component))
          throw new Error('INVALID_ARGS: component must look like CMP-003');
        return {
          content: [
            { type: 'text', text: renderLldCheck(await checkLld(storeFor(ctx), component)) },
          ],
          details: {},
        };
      },
    });

    pi.registerTool({
      name: SWA_IMPACT,
      label: 'SWA impact',
      description:
        'Change impact: which inputs and artifacts changed since the artifacts built from them were written (by the input hashes in their frontmatter), every artifact affected directly or transitively, and the earliest gate to re-enter. With `mark: true` it also marks the affected artifacts stale (their gates reopen).',
      parameters: Type.Unsafe<{ mark?: boolean }>({
        type: 'object',
        properties: { mark: { type: 'boolean' } },
        additionalProperties: false,
      }),
      executionMode: 'sequential',
      execute: async (_id, params, _signal, _onUpdate, ctx) => {
        const store = storeFor(ctx);
        const report = await impact(store);
        const marked =
          (params as { mark?: unknown }).mark === true
            ? await markStale(store, report.affected)
            : undefined;
        return {
          content: [{ type: 'text', text: renderImpact(report, marked) }],
          details: { affected: report.affected.length },
        };
      },
    });

    if (options.command === false) return;

    pi.registerCommand('swa', {
      description: 'Software architecture workflow: /swa status, /swa intake, /swa approve G1, …',
      getArgumentCompletions: (prefix) =>
        [
          'status',
          'init',
          'intake',
          'stack',
          'hld',
          'review-design',
          'lld',
          'review-code',
          'impact',
          'adr',
          'approve',
          'override',
          'help',
        ]
          .filter((c) => c.startsWith(prefix.trim()))
          .map((c) => ({ value: c, label: c })),
      handler: async (args, ctx) => {
        const [sub = 'help', ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const tail = rest.join(' ');
        const store = storeFor(ctx);
        const say = (text: string, level: 'info' | 'warning' | 'error' = 'info') =>
          ctx.ui.notify(text, level);
        switch (sub) {
          case 'help':
            return say(HELP);
          case 'status':
            return say(renderStatus(await snapshot(store)));
          case 'init':
            return say(await initInputs(store, resources));
          case 'approve': {
            const result = await approveGate(store, tail, architect, resources);
            if (result.ok && result.baseline) say(await tagBaseline(pi, ctx.cwd, result.message));
            else say(result.message, result.ok ? 'info' : 'warning');
            return;
          }
          case 'override': {
            const result = await overridePhase(store, tail, architect);
            return say(result.message, result.ok ? 'info' : 'warning');
          }
          default: {
            const phase = COMMAND_PHASE[sub];
            if (!phase || !isPhaseId(phase))
              return say(`Unknown: /swa ${sub}.\n${HELP}`, 'warning');
            const component = phase === 'lld' ? rest[0]?.toUpperCase() : undefined;
            const start = canStart(await snapshot(store), phase, component);
            if (!start.ok) return say(start.reason, 'warning');
            if (component && !(await modelComponents(store)).some((c) => c.id === component)) {
              return say(`${component} is not a component in arch/model.yaml.`, 'warning');
            }
            const template = `swa-${sub}`;
            if (!pi.getCommands().some((c) => c.source === 'prompt' && c.name === template)) {
              return say(`/swa ${sub} is not available in this version yet.`, 'warning');
            }
            pi.sendUserMessage(`/${template}${tail ? ` ${tail}` : ''}`, {
              expandPromptTemplates: true,
              ...(!ctx.isIdle() && { deliverAs: 'followUp' as const }),
            });
          }
        }
      },
    });
  };
}

/**
 * G2 is the baseline: tag it in Git when arch/ is committed; otherwise say how. Never commits for
 * the architect.
 */
async function tagBaseline(pi: ExtensionAPI, cwd: string, message: string): Promise<string> {
  const tag = `swa-baseline-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  try {
    const dirty = await pi.exec('git', ['status', '--porcelain', '--', 'arch'], {
      cwd,
      timeout: 10_000,
    });
    if (dirty.code !== 0) return `${message} (Not a Git repository: no baseline tag.)`;
    if (dirty.stdout.trim()) {
      return `${message} Commit arch/, then tag the baseline: git tag ${tag}`;
    }
    const made = await pi.exec('git', ['tag', tag], { cwd, timeout: 10_000 });
    return made.code === 0
      ? `${message} Tagged ${tag}.`
      : `${message} (Could not tag: git tag ${tag})`;
  } catch {
    return `${message} (Git is not available: no baseline tag.)`;
  }
}
