import type { CreateTurnRequest } from '@parallelflow/runtime-client';
import {
  commandsFor,
  PROFILE_SKILLS,
  type ParallelFlowJob,
  type ParallelFlowProfile,
  type ParallelFlowSessionContext,
  type ParallelFlowTurnContext,
  wrapMessage,
} from '@parallelflow/pi-parallelflow';
import type { SessionMeta } from './store.js';

// Harness profiles (RIC Capabilities.profiles). What the model is told lives in the ParallelFlow Pi
// extension (@parallelflow/pi-parallelflow: system prompt sections, rules, skills, templates); this file only maps
// RIC requests onto the extension's per-session and per-turn data. Autonomy is enforced in the
// harness (the extension's tool_call hook, layer 1) and again by App Tools (layer 2, doc 08).

export const PROFILES = {
  central_arena: 'The AI teammate of one arena (central agent).',
  personal_private: "A person's private AI assistant (personal agent).",
} as const satisfies Partial<Record<ParallelFlowProfile, string>>; // coder runs in VS Code, not here

export type ProfileName = keyof typeof PROFILES;

export const isProfile = (name: string): name is ProfileName => name in PROFILES;

export { fenceData, modelToolName } from '@parallelflow/pi-parallelflow';

/** The App Tool the runtime no longer exposes: questions go through the extension's ask_user. */
export const HIDDEN_APP_TOOLS: ReadonlySet<string> = new Set(['ask.question']);

/** The extension's session data from the stored session. */
export function sessionContext(
  meta: Pick<SessionMeta, 'profile' | 'agent' | 'context_seed'>,
  extensions: readonly string[] = [],
): ParallelFlowSessionContext {
  const seed = meta.context_seed ?? {};
  const profile = isProfile(meta.profile) ? meta.profile : 'central_arena';
  return {
    profile,
    // Private extensions only: the arena's AI is a general teammate (ADR-039).
    ...(profile === 'personal_private' && extensions.length && { extensions: [...extensions] }),
    agentName: meta.agent.display_name,
    ...(seed.org_brief && { waysOfWorking: seed.org_brief }),
    ...(seed.project_brief && { arenaBrief: seed.project_brief }),
    ...(seed.members?.length && {
      members: seed.members.map((m) => ({ display_name: m.display_name, roles: m.roles })),
    }),
  };
}

/** RIC CreateTurnRequest fields added in v0.2.1 (additive; older apps send none of them). */
export interface TurnExtras {
  task_ref?: { task_id?: string; title?: string; instructions?: string };
  routine_ref?: { kind?: string; prompt?: string };
  context?: {
    arena_brief?: string;
    members?: { display_name: string; roles: string[] }[];
    bridge?: { brief?: string; text: string };
  };
  ephemeral_fork?: boolean;
  skill?: string;
}

/** Skill runs that summarise (the state log, the nightly memory, ADR-045): the summary job. */
const SUMMARY_SKILLS: ReadonlySet<string> = new Set([
  'summarize-state',
  'extract-memory',
  'narrate-day',
]);

const COMMAND_JOBS: Record<string, ParallelFlowJob> = {
  spec: 'document',
  plan: 'document',
  tasks: 'document',
  gate: 'document',
  diagram: 'document',
  swa: 'document',
  pm: 'document',
  review: 'review',
  summarize: 'summary',
};

/** A leading "/name args" that is one of the profile's commands: its first line and the rest. */
export function commandOf(
  text: string,
  profile: ProfileName,
  extensions: readonly string[] = [],
): { name: string; line: string; rest: string } | null {
  const trimmed = text.trimStart();
  const match = /^\/([a-z][a-z0-9-]*)\b/.exec(trimmed);
  if (!match?.[1]) return null;
  if (!commandsFor(profile, extensions).some((c) => c.name === match[1])) return null;
  const newline = trimmed.indexOf('\n');
  return {
    name: match[1],
    line: (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim(),
    rest: newline === -1 ? '' : trimmed.slice(newline + 1).trim(),
  };
}

/** What the harness gets for one turn: the prompt text, whether Pi expands it, the turn data. */
export interface TurnPlan {
  text: string;
  expand: boolean;
  context: ParallelFlowTurnContext;
}

export function planTurn(
  request: CreateTurnRequest,
  profile: ProfileName,
  notes: readonly string[] = [],
  extensions: readonly string[] = [],
): TurnPlan {
  const extra = request as CreateTurnRequest & TurnExtras;
  const author = request.input.author;
  const state = request.app_state;
  const ctx: ParallelFlowTurnContext = {
    speaker: {
      name: author.display_name,
      ...(author.roles?.length && { roles: author.roles }),
      ...(author.type === 'system' && { system: true }),
    },
    ...((state?.cycle_number !== undefined || state?.stage) && {
      cycle: {
        ...(state.cycle_number !== undefined && { number: state.cycle_number }),
        ...(state.stage && { stage: state.stage }),
      },
    }),
    ...(request.autonomy && { autonomy: request.autonomy }),
    ...(notes.length && { notes }),
    ...(request.input.attachments?.length && { attachments: request.input.attachments }),
    ...(request.mode === 'assignment' && extra.task_ref && { task: extra.task_ref }),
    ...(request.mode === 'routine' && extra.routine_ref && { routine: extra.routine_ref }),
    ...(extra.context?.bridge?.text && { bridge: extra.context.bridge }),
    ...(extra.context?.arena_brief && { arenaBrief: extra.context.arena_brief }),
    ...(extra.context?.members?.length && { members: extra.context.members }),
  };

  // A skill run (e.g. the state summary in an ephemeral fork): Pi expands /skill:name.
  if (extra.skill && PROFILE_SKILLS[profile].includes(extra.skill)) {
    return {
      text: `/skill:${extra.skill} ${request.input.text}`,
      expand: true,
      context: { ...ctx, job: SUMMARY_SKILLS.has(extra.skill) ? 'summary' : 'document' },
    };
  }
  const command = commandOf(request.input.text, profile, extensions);
  if (command) {
    return {
      text: command.line,
      expand: true,
      context: {
        ...ctx,
        job: COMMAND_JOBS[command.name] ?? 'document',
        ...(command.rest && { messageContext: command.rest }),
      },
    };
  }
  return { text: wrapMessage(request.input.text, ctx.speaker), expand: false, context: ctx };
}
