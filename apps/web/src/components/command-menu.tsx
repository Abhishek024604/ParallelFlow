'use client';

import { type AiCommand, aiCommandQuery } from '@parallelflow/contracts';
import { type KeyboardEvent, type RefObject, useState } from 'react';

// The composer's "/" menu: typing "/" at the very start of the box lists the AI commands (and any
// local ones, e.g. "/arena" in a private chat). It only inserts "/name "; the API and the runtime
// decide what a command does.

export type ComposerCommand = Pick<AiCommand, 'name' | 'description' | 'argumentHint'>;

export function useCommandMenu(
  commands: readonly ComposerCommand[],
  input: RefObject<HTMLTextAreaElement | null>,
  setText: (text: string) => void,
) {
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const options =
    query === null || commands.length === 0
      ? []
      : commands.filter((c) => c.name.startsWith(query.toLowerCase()));
  const open = options.length > 0;

  const pick = (command: ComposerCommand) => {
    const el = input.current;
    const rest = el ? el.value.slice(el.selectionStart).replace(/^\S*/, '') : '';
    const next = `/${command.name} ${rest.trimStart()}`;
    const at = command.name.length + 2;
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };

  return {
    open,
    options,
    active: Math.min(active, Math.max(0, options.length - 1)),
    pick,
    close: () => setQuery(null),
    /** Call from the textarea's onChange. */
    onChange: (value: string, caret: number) => {
      setQuery(aiCommandQuery(value, caret));
      setActive(0);
    },
    /** Call first in onKeyDown: true when the menu handled the key. */
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + options.length) % options.length);
        return true;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        event.preventDefault();
        const chosen = options[Math.min(active, options.length - 1)];
        if (chosen) pick(chosen);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setQuery(null);
        return true;
      }
      return false;
    },
  };
}

export function CommandMenu({ id, menu }: { id: string; menu: ReturnType<typeof useCommandMenu> }) {
  if (!menu.open) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label="Commands"
      className="card absolute bottom-full left-0 z-20 mb-2 max-h-64 w-80 max-w-full overflow-y-auto p-1 shadow-card"
    >
      {menu.options.map((command, i) => (
        <li
          key={command.name}
          id={`${id}-${command.name}`}
          role="option"
          aria-selected={i === menu.active}
          onMouseDown={(event) => {
            event.preventDefault();
            menu.pick(command);
          }}
          className={`cursor-pointer rounded px-2 py-1.5 ${i === menu.active ? 'bg-ai-soft' : ''}`}
        >
          <span className="text-[14px] font-medium text-text">/{command.name}</span>
          {command.argumentHint && (
            <span className="ml-1.5 text-[12px] text-faint">{command.argumentHint}</span>
          )}
          <span className="block text-[12px] text-muted">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}
