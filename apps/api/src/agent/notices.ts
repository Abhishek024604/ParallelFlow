import type { LoopActionResult, SdlcStage } from '@saras/contracts';
import type { Tx } from '@saras/db';

// What the arena's AI is told when something happens outside the chat (TurnRunner.notify). One plain
// line of facts each: names, never ids; the reason someone typed is quoted, clipped.

const REASON_MAX = 300;

const quoted = (reason: string | null | undefined) => {
  const text = reason?.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return `: "${text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text}"`;
};

/** The person's display name (a notice names people). */
export async function displayName(tx: Tx, userId: string): Promise<string> {
  const row = await tx
    .selectFrom('users')
    .select('display_name')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.display_name ?? 'A teammate';
}

export const gateRequestedNotice = (name: string, r: LoopActionResult, summary?: string | null) =>
  `${name} asked for the ${r.stage} gate review in cycle ${r.cycle_number}${quoted(summary)}.`;

export const gateAdvancedNotice = (
  name: string,
  a: { cycleNumber: number; fromStage: SdlcStage; toStage: SdlcStage },
) => `${name} approved the ${a.fromStage} gate: cycle ${a.cycleNumber} moved to ${a.toStage}.`;

export const gateRejectedNotice = (name: string, r: LoopActionResult, reason?: string | null) =>
  `${name} rejected the ${r.stage} gate review in cycle ${r.cycle_number}${quoted(reason)}.`;

export const sentBackNotice = (name: string, r: LoopActionResult, reason?: string | null) =>
  `${name} sent cycle ${r.cycle_number} back to ${r.stage}${quoted(reason)}.`;

export const joinedNotice = (name: string) => `${name} joined the arena.`;
