// AI slash commands ("/spec checkout flow"). The Pi prompt templates in packages/pi-saras/prompts are
// the source of what each command makes the AI do; this list is what the web composer menu shows and
// what the API treats as an AI request. A pi-saras unit test keeps the two in sync.

export type AiSurface = 'arena' | 'private';

export interface AiCommand {
  name: string;
  description: string;
  /** `<required>` / `[optional]`, as in the template's argument-hint. */
  argumentHint?: string;
  surfaces: readonly AiSurface[];
}

export const AI_COMMANDS: readonly AiCommand[] = [
  {
    name: 'spec',
    description: 'Write a spec for a feature as a draft document',
    argumentHint: '<feature>',
    surfaces: ['arena', 'private'],
  },
  {
    name: 'plan',
    description: 'Plan this cycle (milestones, owners, risks) as a draft plan',
    argumentHint: '[focus]',
    surfaces: ['arena'],
  },
  {
    name: 'review',
    description: 'Review a change, document or file for correctness, security and tests',
    argumentHint: '<what to review>',
    surfaces: ['arena'],
  },
  {
    name: 'summarize',
    description: 'Summarize the conversation so far (decisions, open questions, next steps)',
    argumentHint: '[topic]',
    surfaces: ['arena', 'private'],
  },
  {
    name: 'tasks',
    description: 'Break work into small, clear tasks',
    argumentHint: '<work to break down>',
    surfaces: ['arena', 'private'],
  },
  {
    name: 'gate',
    description: 'Check whether the current stage is ready for its gate review',
    argumentHint: '[stage]',
    surfaces: ['arena'],
  },
  {
    name: 'diagram',
    description: 'Draw an architecture or flow diagram as a draw.io document',
    argumentHint: '<what to draw>',
    surfaces: ['arena', 'private'],
  },
  {
    name: 'swa',
    description:
      'Software architecture: requirements to stack, HLD, LLD and reviews, with approvals',
    argumentHint: '<status | intake | stack | hld | review-design | lld CMP-id | impact>',
    surfaces: ['arena'],
  },
];

export const aiCommandsFor = (surface: AiSurface): AiCommand[] =>
  AI_COMMANDS.filter((c) => c.surfaces.includes(surface));

/**
 * The command a message starts with ("/spec checkout flow" → spec, "checkout flow"), or null when it
 * does not start with a command of this surface. Only the first line is the command.
 */
export function parseAiCommand(
  text: string,
  surface: AiSurface,
): { name: string; args: string } | null {
  const match = /^\/([a-z][a-z0-9-]*)(?:[ \t]+([^\n]*))?(?:\n|$)/.exec(text.trimStart());
  if (!match?.[1]) return null;
  const command = AI_COMMANDS.find((c) => c.name === match[1] && c.surfaces.includes(surface));
  return command ? { name: command.name, args: (match[2] ?? '').trim() } : null;
}

/**
 * The message as the AI should read a command: "@AI /spec checkout" → "/spec checkout" (a leading
 * @AI is dropped so the command comes first), or null when the message is not a command here.
 */
export function aiCommandText(text: string, surface: AiSurface): string | null {
  const trimmed = text.trimStart().replace(/^@ai[ \t,:]+(?=\/)/i, '');
  return parseAiCommand(trimmed, surface) ? trimmed : null;
}

/**
 * The `/name` being typed at the caret at the very start of the text (the composer's menu), or null.
 */
export function aiCommandQuery(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const match = /^\/([a-z0-9-]*)$/.exec(before);
  return match ? (match[1] ?? '') : null;
}
