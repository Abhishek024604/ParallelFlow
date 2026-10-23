'use client';

import { type PrivateChat, type PrivateProject, uuidv7 } from '@parallelflow/contracts';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type DragEvent, type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { apiPost, apiSend, ProblemError } from '../lib/api-browser';
import { announce, type Optimistic, retract, tempId, useOptimisticList } from '../lib/optimistic';
import { relativeAge } from '../lib/chat';
import { applyMoves, type ChatMoves, countDelta, pendingMoves } from '../lib/chat-moves';
import { FileIcon, PencilIcon, PlusIcon, SearchIcon, XIcon } from './icons';
import { RowMenu, type RowMenuItem } from './row-menu';

// Private sidebar (screen 01, CLAUDE.md: works like ChatGPT projects): New chat, Search chats,
// My files (step 6), PROJECTS (your folders of private chats, each expands to its chats) and
// RECENT CHATS (chats in no project). The lists come from the server layout; every change calls
// router.refresh() to reload them. Only titles are shown, never message text.
// Chats move between projects and Recent by drag and drop (or a chat's ⋯ menu, for keyboards); the
// move shows at once and is undone if the server refuses it. Each project has its own New chat.

const CHAT_DRAG_TYPE = 'application/x-parallelflow-chat';
const RECENT = 'recent';

const FOLDER_ICON = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="label px-3">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Please try again.';

/** A one-line name input (new project, rename). Enter saves, Escape cancels. */
function NameInput({
  label,
  initial = '',
  onSave,
  onCancel,
}: {
  label: string;
  initial?: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
    } catch (err) {
      setError(errorText(err));
      setSaving(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="px-2 py-1">
      <input
        aria-label={label}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => {
          if (!name.trim()) onCancel();
        }}
        maxLength={80}
        autoFocus
        autoComplete="off"
        disabled={saving}
        className="inp h-9 w-full px-2.5 text-[14px]"
      />
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-bad">
          {error}
        </p>
      )}
    </form>
  );
}

function ChatLink({
  chat,
  active,
  now,
  moveItems,
}: {
  chat: Optimistic<PrivateChat>;
  active: boolean;
  now: Date;
  /** "Move to …" choices (the keyboard alternative to dragging). */
  moveItems: RowMenuItem[];
}) {
  const age = chat.last_message_at ?? chat.created_at;
  if (chat.pending) {
    return (
      <span
        aria-busy="true"
        className="nav flex h-9 items-center gap-2 px-3 text-[14px] text-text opacity-60"
      >
        <span className="min-w-0 flex-1 truncate">{chat.title ?? 'New chat'}</span>
        <span className="shrink-0 text-[12px] text-faint">Starting…</span>
      </span>
    );
  }
  return (
    <div className="group flex items-center">
      <Link
        href={`/private/${chat.id}`}
        aria-current={active ? 'page' : undefined}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(CHAT_DRAG_TYPE, chat.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        className={`nav flex h-9 min-w-0 flex-1 items-center gap-2 px-3 text-[14px] text-text no-underline ${
          active ? 'bg-panel shadow-card' : ''
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{chat.title ?? 'New chat'}</span>
        {chat.bound_project && (
          <span
            className="chip max-w-[96px] shrink-0 truncate px-1.5 py-0 text-[11px]"
            title={`Context from arena · ${chat.bound_project.name}`}
          >
            {chat.bound_project.name}
          </span>
        )}
        <time dateTime={age} className="shrink-0 text-[12px] text-faint">
          {relativeAge(age, now)}
        </time>
      </Link>
      {moveItems.length > 0 && (
        <RowMenu label={`Move ${chat.title ?? 'New chat'}`} items={moveItems} />
      )}
    </div>
  );
}

export function PrivateSidebar({
  chats: serverChats,
  projects: serverProjects,
}: {
  chats: PrivateChat[];
  projects: PrivateProject[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  // New chats and projects show at once (lib/optimistic.ts), before the refresh brings them.
  const listed = useOptimisticList('chats', serverChats, true);
  const [moves, setMoves] = useState<ChatMoves>(new Map());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const chats = applyMoves(listed, moves);
  // A move is settled once the server's list shows it.
  useEffect(() => {
    setMoves((current) => pendingMoves(current, serverChats));
  }, [serverChats]);
  const projects = useOptimisticList('projects', serverProjects, false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // Relative times depend on the clock: computed after mount, refreshed every minute.
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Ctrl/Cmd+N: new chat (where the browser lets the page have it).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        router.push('/private');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const query = search.trim().toLowerCase();
  const matches = (chat: PrivateChat) =>
    !query || (chat.title ?? 'New chat').toLowerCase().includes(query);
  const visible = chats.filter(matches);
  const recent = visible.filter((c) => c.private_project_id === null);
  const activeChat = pathname.startsWith('/private/') ? pathname.slice('/private/'.length) : '';

  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const createProject = async (name: string) => {
    // Optimistic: the project shows at once; a failure removes it and says why.
    const temp = tempId();
    setCreating(false);
    setError(null);
    announce<Optimistic<PrivateProject>>('projects', {
      id: temp,
      name,
      chat_count: 0,
      created_at: new Date().toISOString(),
      pending: true,
    });
    try {
      const project = await apiPost<PrivateProject>(
        '/private/projects',
        { name },
        { idempotencyKey: uuidv7() },
      );
      announce('projects', project, temp);
      setOpen((current) => new Set(current).add(project.id));
      router.refresh();
    } catch (err) {
      retract('projects', temp);
      setError(errorText(err));
    }
  };

  const renameProject = async (id: string, name: string) => {
    await apiSend('PATCH', `/private/projects/${id}`, { name });
    setRenaming(null);
    router.refresh();
  };

  const moveChat = async (chatId: string, to: string | null) => {
    const chat = chats.find((c) => c.id === chatId);
    if (!chat || chat.pending || chat.private_project_id === to) return;
    setError(null);
    setMoves((current) => new Map(current).set(chatId, to));
    if (to) setOpen((current) => new Set(current).add(to));
    try {
      await apiSend('PUT', `/private/sessions/${chatId}/project`, { private_project_id: to });
      router.refresh();
    } catch (err) {
      setMoves((current) => {
        const next = new Map(current);
        next.delete(chatId);
        return next;
      });
      setError(errorText(err));
    }
  };

  const moveItemsFor = (chat: PrivateChat): RowMenuItem[] => [
    ...projects
      .filter((p) => !p.pending && p.id !== chat.private_project_id)
      .map((p) => ({ label: `Move to ${p.name}`, onSelect: () => void moveChat(chat.id, p.id) })),
    ...(chat.private_project_id
      ? [{ label: 'Move to Recent chats', onSelect: () => void moveChat(chat.id, null) }]
      : []),
  ];

  /** Drag and drop handlers for a drop target (a project, or Recent chats). */
  const dropProps = (target: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(CHAT_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropTarget !== target) setDropTarget(target);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDropTarget(null);
      const chatId = event.dataTransfer.getData(CHAT_DRAG_TYPE);
      if (chatId) void moveChat(chatId, target === RECENT ? null : target);
    },
  });
  const dropClass = (target: string) =>
    dropTarget === target ? 'rounded-lg bg-raise ring-1 ring-line2' : '';

  const [startingIn, setStartingIn] = useState<string | null>(null);
  const newChatIn = async (projectId: string) => {
    if (startingIn) return;
    setStartingIn(projectId);
    setError(null);
    try {
      const chat = await apiPost<PrivateChat>(
        '/private/sessions',
        { private_project_id: projectId },
        { idempotencyKey: uuidv7() },
      );
      setOpen((current) => new Set(current).add(projectId));
      router.push(`/private/${chat.id}`);
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStartingIn(null);
    }
  };

  const deleteProject = async (project: PrivateProject) => {
    if (!window.confirm(`Delete "${project.name}"? Its chats move to Recent chats.`)) return;
    setError(null);
    try {
      await apiSend('DELETE', `/private/projects/${project.id}`);
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <aside
      aria-label="Private"
      className="flex w-[270px] shrink-0 flex-col border-r border-line bg-side px-3 pb-3 pt-3.5"
    >
      <Link
        href="/private"
        className="card flex h-11 w-full items-center gap-3 px-3 text-left text-[15px] font-medium text-text no-underline shadow-card"
      >
        <PencilIcon />
        New chat
        <span className="kbd chip ml-auto px-1.5 text-[11px] leading-5 text-faint">Ctrl N</span>
      </Link>
      <div className="mt-2 space-y-0.5">
        {searching ? (
          <div className="flex items-center gap-2 px-2">
            <SearchIcon className="shrink-0 text-faint" />
            <input
              ref={searchInput}
              aria-label="Search chats"
              placeholder="Search chats"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setSearch('');
                  setSearching(false);
                }
              }}
              autoFocus
              autoComplete="off"
              className="inp h-9 min-w-0 flex-1 px-2.5 text-[14px]"
            />
            <button
              type="button"
              className="btn ghost h-8 w-8 shrink-0 p-0"
              aria-label="Close search"
              onClick={() => {
                setSearch('');
                setSearching(false);
              }}
            >
              <XIcon />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="nav flex h-9 w-full items-center gap-3 px-3 text-left text-[15px] text-text"
            onClick={() => setSearching(true)}
          >
            <SearchIcon />
            Search chats
          </button>
        )}
        <Link
          href="/private/files"
          aria-current={pathname.startsWith('/private/files') ? 'page' : undefined}
          className="nav flex h-9 w-full items-center gap-3 px-3 text-left text-[15px] text-text"
        >
          <FileIcon />
          My files
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section title="Projects">
          {creating ? (
            <NameInput
              label="Project name"
              onSave={createProject}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <button
              type="button"
              className="nav flex h-9 w-full items-center gap-3 px-3 text-left text-[14px] text-muted"
              onClick={() => setCreating(true)}
            >
              <PlusIcon />
              New project
            </button>
          )}
          {error && (
            <p role="alert" className="px-3 py-1 text-[12px] text-bad">
              {error}
            </p>
          )}
          {projects.length === 0 && !creating && (
            <p className="px-3 py-1.5 text-[13px] text-faint">No projects yet</p>
          )}
          <ul className="space-y-0.5">
            {projects.map((project) => {
              const inside = visible.filter((c) => c.private_project_id === project.id);
              const expanded = open.has(project.id) || (query !== '' && inside.length > 0);
              if (project.pending) {
                return (
                  <li key={project.id} aria-busy="true">
                    <span className="nav flex h-9 items-center gap-3 px-3 text-[14px] text-text opacity-60">
                      <span className="text-muted">{FOLDER_ICON}</span>
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      <span className="text-[12px] text-faint">Creating…</span>
                    </span>
                  </li>
                );
              }
              if (renaming === project.id) {
                return (
                  <li key={project.id}>
                    <NameInput
                      label="Project name"
                      initial={project.name}
                      onSave={(name) => renameProject(project.id, name)}
                      onCancel={() => setRenaming(null)}
                    />
                  </li>
                );
              }
              return (
                <li key={project.id} {...dropProps(project.id)} className={dropClass(project.id)}>
                  <div className="group flex items-center">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggle(project.id)}
                      className="nav flex h-9 min-w-0 flex-1 items-center gap-3 px-3 text-left text-[14px] text-text"
                    >
                      <span className="text-muted">{FOLDER_ICON}</span>
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      <span className="text-[12px] text-faint">
                        {project.chat_count + countDelta(project.id, listed, moves)}
                      </span>
                    </button>
                    <RowMenu
                      label={`Options for ${project.name}`}
                      items={[
                        { label: 'New chat', onSelect: () => void newChatIn(project.id) },
                        { label: 'Rename', onSelect: () => setRenaming(project.id) },
                        {
                          label: 'Delete',
                          danger: true,
                          onSelect: () => void deleteProject(project),
                        },
                      ]}
                    />
                  </div>
                  {expanded && (
                    <ul className="ml-5 border-l border-line pl-1">
                      <li>
                        <button
                          type="button"
                          onClick={() => void newChatIn(project.id)}
                          disabled={startingIn === project.id}
                          className="nav flex h-8 w-full items-center gap-2 px-3 text-left text-[13px] text-muted"
                        >
                          <PlusIcon size={14} />
                          {startingIn === project.id ? 'Starting…' : 'New chat'}
                        </button>
                      </li>
                      {inside.length === 0 ? (
                        <li className="px-3 py-1.5 text-[12px] text-faint">
                          No chats yet. Drag one here.
                        </li>
                      ) : (
                        inside.map((chat) => (
                          <li key={chat.id}>
                            {now && (
                              <ChatLink
                                chat={chat}
                                active={chat.id === activeChat}
                                now={now}
                                moveItems={moveItemsFor(chat)}
                              />
                            )}
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>

        <div {...dropProps(RECENT)} className={dropClass(RECENT)}>
          <Section title="Recent chats">
            {recent.length === 0 ? (
              <p className="px-3 py-1.5 text-[13px] text-faint">
                {query ? 'No chats match' : 'No chats yet'}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {recent.map((chat) => (
                  <li key={chat.id}>
                    {now && (
                      <ChatLink
                        chat={chat}
                        active={chat.id === activeChat}
                        now={now}
                        moveItems={moveItemsFor(chat)}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>

      <p className="mt-3 border-t border-line px-3 pt-3 text-[12px] text-faint">
        Private chats are visible only to you.
      </p>
    </aside>
  );
}
