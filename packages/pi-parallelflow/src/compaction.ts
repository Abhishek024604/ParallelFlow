// What a ParallelFlow compaction summary must keep (appended to Pi's own summary prompt as "Additional
// focus"). The arena's history is a team's working memory: losing who decided what, or which
// documents exist, would make the AI contradict the team.

export const COMPACTION_FOCUS = [
  'This is a team workspace conversation. The summary must keep, in their own short sections:',
  '- Decisions: every decision made, who made it, and when (keep exact wording of what was decided).',
  '- Owners: who owns or is doing each piece of work.',
  '- Open questions: questions not answered yet, and who asked them.',
  '- Current stage: the cycle number and stage (Plan, Design, Build, Test, Deploy, Maintain) and any gate in progress.',
  '- Documents: the name of every document, spec, plan or file mentioned or saved, with its latest version when known.',
  'Refer to people by name. Leave out greetings and small talk. Never include ids, tokens or keys.',
].join('\n');

/** Pi's custom instructions for one compaction (an explicit /compact request keeps its own focus). */
export function compactionInstructions(custom?: string): string {
  return custom?.trim() ? `${COMPACTION_FOCUS}\n\nAlso: ${custom.trim()}` : COMPACTION_FOCUS;
}
