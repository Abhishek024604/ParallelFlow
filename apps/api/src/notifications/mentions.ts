// "@Name" mentions of teammates in an arena message (plain text: the composer inserts "@<display
// name> "). A name counts when it starts the text or follows a non-word character, and is not
// followed by more letters ("@Ann" does not match "@Anna"). @AI is the AI, never a person.

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function mentionedUserIds(
  body: string,
  members: readonly { user_id: string; display_name: string }[],
): string[] {
  if (!body.includes('@')) return [];
  const found = new Set<string>();
  for (const member of members) {
    const name = member.display_name.trim();
    if (!name || name.toLowerCase() === 'ai') continue;
    const pattern = new RegExp(String.raw`(?<![\w@.])@${escape(name)}(?![\p{L}\p{N}_])`, 'iu');
    if (pattern.test(body)) found.add(member.user_id);
  }
  return [...found];
}
