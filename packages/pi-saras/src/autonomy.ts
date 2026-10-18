import type { AutonomyLevel, AutonomyPolicy } from './context.js';

// Autonomy layer 1, inside the harness (Pi `tool_call`): a tool the turn's policy forbids is blocked
// before App Tools ever sees the call, with a reason the model reads and explains. App Tools checks
// the same policy again on its side (layer 2, doc 08). Classes follow x-saras.autonomy_class in
// docs/contracts/app-tools_v0.2.mcp.json; a tool without a class is never blocked here.

/** App Tools name → autonomy class. */
export const TOOL_CLASSES: Readonly<Record<string, string>> = {
  'arena.read_history': 'answer',
  'knowledge.search': 'answer',
  'arena.post_message': 'post',
  'artifacts.create_draft': 'draft_artifacts',
  'tasks.create_draft': 'tasks',
  'delegation.suggest': 'tasks',
  'stage.request_gate': 'request_gate',
  'notify.tag': 'notify',
  'tasks.update_status': 'assigned_work',
};

/** Tools whose output is a draft for people to review: the only ones a "suggest" class may use. */
export const DRAFT_TOOLS: ReadonlySet<string> = new Set([
  'artifacts.create_draft',
  'private.save_artifact',
  'tasks.create_draft',
  'delegation.suggest',
]);

export type AutonomyDecision = { block: false } | { block: true; reason: string };

const ALLOW: AutonomyDecision = { block: false };

/** Whether the App Tool `tool` may run under `policy`, and the model-facing reason if not. */
export function autonomyDecision(
  tool: string,
  policy: AutonomyPolicy | undefined,
): AutonomyDecision {
  const cls = TOOL_CLASSES[tool];
  if (!cls || !policy) return ALLOW;
  const level: AutonomyLevel | undefined = policy[cls];
  switch (level) {
    case 'off':
      return {
        block: true,
        reason: `BLOCKED: this arena has turned that off for the AI. Do not do it or try another way; tell the person plainly that a teammate needs to do it.`,
      };
    case 'approve':
      return {
        block: true,
        reason: `NEEDS_APPROVAL: a teammate must approve this first. Do not retry; explain in your reply what you would do and ask them to approve or do it.`,
      };
    case 'suggest':
      return DRAFT_TOOLS.has(tool)
        ? ALLOW
        : {
            block: true,
            reason: `SUGGEST_ONLY: you may only suggest this. Do not retry; describe in your reply what you would do (or save it as a draft) so a teammate can do it.`,
          };
    default:
      return ALLOW;
  }
}
