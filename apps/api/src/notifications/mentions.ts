// "@Name" mentions of teammates in an arena message (plain text: the composer inserts "@<display
// name> "). A name counts when it starts the text or follows a non-word character, and is not
// followed by more letters ("@Ann" does not match "@Anna"). Case is ignored. A first name alone
// ("@asha" for "Asha Rao") counts too, unless two teammates share that first name. @AI is the AI,
// never a person.

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const tagged = (body: string, name: string): boolean =>
  new RegExp(String.raw`(?<![\w@.])@${escape(name)}(?![\p{L}\p{N}_])`, 'iu').test(body);

const firstName = (name: string): string => name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';

export function mentionedUserIds(
  body: string,
  members: readonly { user_id: string; display_name: string }[],
): string[] {
  if (!body.includes('@')) return [];
  const firstNames = new Map<string, number>();
  for (const m of members) {
    const first = firstName(m.display_name);
    if (first) firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
  }
  const found = new Set<string>();
  for (const member of members) {
    const name = member.display_name.trim();
    if (!name || name.toLowerCase() === 'ai') continue;
    const first = firstName(name);
    if (
      tagged(body, name) ||
      (first !== 'ai' &&
        first !== name.toLowerCase() &&
        firstNames.get(first) === 1 &&
        tagged(body, first))
    ) {
      found.add(member.user_id);
    }
  }
  return [...found];
}
