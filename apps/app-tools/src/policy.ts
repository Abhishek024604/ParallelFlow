import type { ToolSpec } from './contract.js';
import type { ToolPrincipal } from './token.js';

// Authorisation rules of App Tools (app-tools_v0.2.mcp.json, doc 08 §8.5). The app enforces the
// agent's autonomy policy here as the second layer; the runtime's prompt is the first.

export type DenyCode =
  'SCOPE_MISMATCH' | 'FORBIDDEN' | 'NOT_FOUND' | 'APPROVAL_REQUIRED' | 'RATE_LIMITED';

export type Autonomy = 'off' | 'suggest' | 'approve' | 'act';

/**
 * Human-only actions (contract `human_only_actions_not_exposed`, CLAUDE.md rules 4 and 5). No tool
 * with one of these names may ever be registered; the server refuses to start if the contract adds one.
 */
export const HUMAN_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'stage.approve',
  'stage.reject',
  'gate.approve',
  'gate.reject',
  'approval.vote',
  'bridge.push',
  'members.manage',
  'members.add',
  'members.remove',
  'roles.manage',
  'gate_policy.update',
  'project.archive',
  'dm.send',
  'tasks.verify',
  'tasks.complete',
  'agent_policy.update',
  'routines.manage',
  'access.approve',
]);

/** Contract tools whose features do not exist yet: FORBIDDEN "not available yet" (SLICE_DEBT.md). */
export const NOT_AVAILABLE_YET: ReadonlySet<string> = new Set([
  'arena.post_message',
  'bridge.propose_push',
  'tasks.list',
  'tasks.create_draft',
  'delegation.suggest',
  'stage.request_gate',
  'notify.tag',
  'tasks.update_status',
  'tasks.comment',
  'approval.request',
  'routine.context',
]);

/** Throws if the contract would expose a human-only action. */
export function assertNoHumanOnly(specs: readonly ToolSpec[]): void {
  const leaked = specs.filter((s) => HUMAN_ONLY_TOOLS.has(s.name)).map((s) => s.name);
  if (leaked.length) throw new Error(`Human-only actions must not be tools: ${leaked.join(', ')}`);
}

/** allowed_agents: "central", "personal" (any personal agent), "personal(bound)" (bound only). */
export function agentAllowed(spec: ToolSpec, p: ToolPrincipal): boolean {
  const allowed = spec['x-saras'].allowed_agents;
  if (p.kind === 'central') return allowed.includes('central');
  if (allowed.includes('personal')) return true;
  return allowed.includes('personal(bound)') && p.projectId !== null;
}

/** May this principal call this tool at all (agent kind, token scopes)? */
export function toolPermitted(spec: ToolSpec, p: ToolPrincipal): boolean {
  return !HUMAN_ONLY_TOOLS.has(spec.name) && agentAllowed(spec, p) && p.scopes.has(spec.name);
}

/** The tools/list answer for this token: permitted and implemented. */
export function listableTools(specs: readonly ToolSpec[], p: ToolPrincipal): ToolSpec[] {
  return specs.filter((s) => toolPermitted(s, p) && !NOT_AVAILABLE_YET.has(s.name));
}

export type AutonomyDecision =
  | { kind: 'allow' }
  /** suggest: only a draft or suggestion may result (drafts are never approved by the AI). */
  | { kind: 'draft_only' }
  | { kind: 'deny'; code: 'FORBIDDEN' | 'APPROVAL_REQUIRED' };

/**
 * The autonomy level of the tool's class against what the tool does.
 *   off → FORBIDDEN; act → allow;
 *   suggest → reads allowed, writes only as a draft / suggestion;
 *   approve → reads allowed, writes need a human approval first (APPROVAL_REQUIRED).
 */
export function decideAutonomy(
  sideEffect: ToolSpec['x-saras']['side_effect'],
  level: Autonomy,
): AutonomyDecision {
  if (level === 'off') return { kind: 'deny', code: 'FORBIDDEN' };
  if (level === 'act' || sideEffect === 'read') return { kind: 'allow' };
  if (level === 'suggest') return { kind: 'draft_only' };
  return { kind: 'deny', code: 'APPROVAL_REQUIRED' };
}

/** Tools whose only effect is a draft or a private file, so draft_only still lets them run. */
export const DRAFT_TOOLS: ReadonlySet<string> = new Set([
  'artifacts.create_draft',
  'private.save_artifact',
]);
