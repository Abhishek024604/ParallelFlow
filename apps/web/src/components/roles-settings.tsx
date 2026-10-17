'use client';

import {
  type CreateRoleInput,
  groupCapabilities,
  type ProjectMember,
  ROLE_COLORS,
  type Role,
  type RoleList,
  type RoleTemplate,
  type UpdateRoleInput,
} from '@saras/contracts';
import { useState } from 'react';
import { apiPost, apiSend, ProblemError } from '../lib/api-browser';
import { roleDot, roleErrorText, toggleRole, withMemberRoles } from '../lib/roles';
import { CheckIcon, PlusIcon } from './icons';

// Arena settings → Roles (screen 07, build step 8). Optional: every arena works with Owner and
// Member. Teammates with `role.manage` pick a template, edit roles and assign them; everyone else
// sees the same page read-only. The server enforces every rule; the page shows its answers inline.

const GROUPS = groupCapabilities();
const RISK_CHIP: Record<string, string> = { high: 'chip warn', medium: 'chip', low: '' };

interface Props {
  projectId: string;
  initialRoles: RoleList;
  initialMembers: ProjectMember[];
  templates: RoleTemplate[];
}

const errorText = (err: unknown): string =>
  err instanceof ProblemError
    ? roleErrorText(err.code, err.detail)
    : 'Something went wrong. Please try again.';

export function RolesSettings({ projectId, initialRoles, initialMembers, templates }: Props) {
  const canManage = initialRoles.viewer.can_manage;
  const [roles, setRoles] = useState<Role[]>(initialRoles.items);
  const [members, setMembers] = useState<ProjectMember[]>(initialMembers);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [memberError, setMemberError] = useState<{ userId: string; text: string } | null>(null);
  const base = `/projects/${encodeURIComponent(projectId)}`;

  async function setMemberRoles(member: ProjectMember, roleIds: string[]) {
    if (roleIds.length === 0) {
      setMemberError({ userId: member.user_id, text: 'A teammate needs at least one role.' });
      return;
    }
    const before = { roles, members };
    const next = withMemberRoles(members, roles, member.user_id, roleIds);
    setRoles(next.roles);
    setMembers(next.members);
    setMemberError(null);
    try {
      const saved = await apiSend<ProjectMember>(
        'PATCH',
        `${base}/members/${encodeURIComponent(member.user_id)}`,
        { role_ids: roleIds },
      );
      setMembers((list) => list.map((m) => (m.user_id === saved.user_id ? saved : m)));
    } catch (err) {
      setRoles(before.roles);
      setMembers(before.members);
      setMemberError({ userId: member.user_id, text: errorText(err) });
    }
  }

  function onSaved(role: Role, replaces?: string) {
    setRoles((list) => {
      const id = replaces ?? role.id;
      return list.some((r) => r.id === id)
        ? list.map((r) => (r.id === id ? role : r))
        : [...list, role];
    });
    // Renames show on the teammates' chips at once.
    setMembers((list) =>
      list.map((m) => ({
        ...m,
        roles: m.roles.map((r) => (r.id === role.id ? { id: r.id, name: role.name } : r)),
      })),
    );
  }

  function onDeleted(roleId: string) {
    setRoles((list) => list.filter((r) => r.id !== roleId));
    setMembers((list) =>
      list.map((m) => ({ ...m, roles: m.roles.filter((r) => r.id !== roleId) })),
    );
    setEditing(null);
  }

  return (
    <div className="mx-auto w-full max-w-[1120px] px-6 py-8">
      <p className="text-[13px] text-faint">Optional · you can set this up any time</p>
      <h1 className="mt-1 text-[26px] font-bold text-text">How is your team organised?</h1>
      <p className="mt-1 text-[15px] text-muted">
        {canManage
          ? 'Start from a template, then rename, add or remove roles. Nothing here is fixed.'
          : 'These are the roles in this arena and what each one can do. Ask an Owner to change them.'}
      </p>

      {canManage && (
        <TemplatePicker
          base={base}
          templates={templates}
          onApplied={(list) => {
            setRoles(list.items);
            setEditing(null);
          }}
        />
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="card min-w-0" aria-labelledby="roles-heading">
          <div className="flex items-center gap-3 border-b border-line px-5 py-4">
            <h2 id="roles-heading" className="text-[16px] font-semibold text-text">
              Roles and what they can do
            </h2>
            {canManage && (
              <button
                type="button"
                className="btn ml-auto h-9 px-3 text-[14px]"
                onClick={() => setEditing('new')}
                disabled={editing === 'new'}
              >
                <PlusIcon />
                Add role
              </button>
            )}
          </div>
          <ul className="divide-y divide-line">
            {editing === 'new' && (
              <li className="px-5 py-4">
                <RoleEditor
                  base={base}
                  onCancel={() => setEditing(null)}
                  onSaved={(role, replaces) => {
                    onSaved(role, replaces);
                    setEditing(null);
                  }}
                />
              </li>
            )}
            {roles.map((role) => (
              <li key={role.id} className="px-5 py-3">
                <RoleRow
                  role={role}
                  open={editing === role.id}
                  canManage={canManage}
                  onToggle={() => setEditing(editing === role.id ? null : role.id)}
                />
                {editing === role.id && (
                  <div className="mt-4">
                    <RoleEditor
                      base={base}
                      role={role}
                      readOnly={!canManage}
                      onCancel={() => setEditing(null)}
                      onSaved={(saved) => onSaved(saved)}
                      onDeleted={onDeleted}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="border-t border-line px-5 py-3 text-[13px] text-faint">
            Stage approvals follow the roles each gate lists. The Owner can do everything.
          </p>
        </section>

        <section className="card h-fit" aria-labelledby="assign-heading">
          <div className="px-5 pt-4">
            <h2 id="assign-heading" className="text-[16px] font-semibold text-text">
              Assign teammates
            </h2>
            <p className="mt-1 text-[13px] text-faint">A teammate can hold more than one role.</p>
          </div>
          <ul className="space-y-4 px-5 py-4">
            {members.map((member) => (
              <li key={member.user_id}>
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="av inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px]"
                  >
                    {member.initials}
                  </span>
                  <span className="min-w-0 truncate text-[14px] font-medium text-text">
                    {member.display_name}
                  </span>
                </div>
                <div
                  className="mt-2 flex flex-wrap gap-1.5 pl-11"
                  role="group"
                  aria-label={`Roles of ${member.display_name}`}
                >
                  {roles.map((role) => {
                    const on = member.roles.some((r) => r.id === role.id);
                    if (!canManage && !on) return null;
                    return (
                      <button
                        key={role.id}
                        type="button"
                        aria-pressed={on}
                        disabled={!canManage}
                        onClick={() => void setMemberRoles(member, toggleRole(member, role.id))}
                        className={`chip inline-flex items-center gap-1.5 px-2 py-0.5 text-[12px] ${
                          on ? 'border-ink bg-ink text-on-ink' : ''
                        } ${canManage ? 'cursor-pointer' : 'cursor-default'}`}
                      >
                        {on && <CheckIcon size={12} />}
                        {role.name}
                      </button>
                    );
                  })}
                </div>
                {memberError?.userId === member.user_id && (
                  <p role="alert" className="mt-2 pl-11 text-[12px] text-bad">
                    {memberError.text}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>

      <p className="mt-6 border-t border-line pt-4 text-[13px] text-faint">
        Every arena needs at least one Owner.
      </p>
    </div>
  );
}

function TemplatePicker({
  base,
  templates,
  onApplied,
}: {
  base: string;
  templates: RoleTemplate[];
  onApplied: (list: RoleList) => void;
}) {
  const [picked, setPicked] = useState<RoleTemplate | null>(null);
  const [gates, setGates] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function apply() {
    if (!picked) return;
    setBusy(true);
    setMessage(null);
    try {
      const list = await apiPost<RoleList>(
        `${base}/roles:apply-template`,
        { template_key: picked.key, gates },
        { idempotencyKey: crypto.randomUUID() },
      );
      onApplied(list);
      setMessage({ ok: true, text: `Added the roles from ${picked.name}.` });
      setPicked(null);
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6" aria-label="Templates">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {templates.map((t) => {
          const on = picked?.key === t.key;
          const names = t.roles.map((r) => r.name).join(', ');
          return (
            <li key={t.key}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setPicked(on ? null : t);
                  setMessage(null);
                }}
                className={`card flex h-full w-full flex-col items-start p-4 text-left hover:bg-raise ${
                  on ? 'border-acc-line bg-acc-soft' : ''
                }`}
              >
                <span className="flex w-full items-start gap-2">
                  <span className="text-[15px] font-semibold text-text">
                    {t.key === 'blank' ? 'Start blank' : t.name}
                  </span>
                  {on && <CheckIcon className="ml-auto mt-0.5 shrink-0 text-acc-ink" />}
                </span>
                <span className="mt-1 text-[13px] text-muted">{t.for}</span>
                <span className="mt-2 line-clamp-2 text-[12px] text-faint">{names}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {picked && (
        <div className="card mt-3 flex flex-wrap items-center gap-4 px-4 py-3">
          <p className="min-w-0 flex-1 text-[14px] text-text">
            Add the roles from <strong>{picked.name}</strong>. Roles you already have stay as they
            are.
          </p>
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input type="checkbox" checked={gates} onChange={(e) => setGates(e.target.checked)} />
            Also set who approves each stage
          </label>
          <button
            type="button"
            className="btn pri h-9 px-4 text-[14px]"
            onClick={() => void apply()}
            disabled={busy}
          >
            {busy ? 'Adding…' : 'Add roles'}
          </button>
        </div>
      )}
      {message && (
        <p
          role={message.ok ? 'status' : 'alert'}
          className={`mt-2 text-[13px] ${message.ok ? 'text-ok' : 'text-bad'}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

function RoleRow({
  role,
  open,
  canManage,
  onToggle,
}: {
  role: Role;
  open: boolean;
  canManage: boolean;
  onToggle: () => void;
}) {
  const count = role.member_count === 1 ? '1 teammate' : `${role.member_count} teammates`;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
    >
      <span
        aria-hidden="true"
        className={`h-2.5 w-2.5 shrink-0 rounded-sm ${roleDot(role.color)}`}
      />
      <span className="text-[15px] font-medium text-text">{role.name}</span>
      {role.system_kind === 'owner' && (
        <span className="chip acc px-2 py-0.5 text-[12px]">Can do everything</span>
      )}
      {role.system_kind === 'observer' && (
        <span className="chip px-2 py-0.5 text-[12px]">Observer</span>
      )}
      {role.approves.length > 0 && (
        <span className="chip px-2 py-0.5 text-[12px]">Approves {role.approves.join(', ')}</span>
      )}
      <span className="ml-auto text-[13px] text-faint">
        {count} · {open ? 'Close' : canManage ? 'Edit' : 'View'}
      </span>
    </button>
  );
}

function RoleEditor({
  base,
  role,
  readOnly = false,
  onCancel,
  onSaved,
  onDeleted,
}: {
  base: string;
  role?: Role;
  readOnly?: boolean;
  onCancel: () => void;
  onSaved: (role: Role, replaces?: string) => void;
  onDeleted?: (roleId: string) => void;
}) {
  const system = role?.system_kind ?? null;
  const capsLocked = readOnly || system !== null;
  const [name, setName] = useState(role?.name ?? '');
  const [color, setColor] = useState<string>(role?.color ?? 'acc');
  const [caps, setCaps] = useState<Set<string>>(
    new Set(role?.capabilities ?? ['arena.read', 'arena.post', 'agent.invoke']),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(key: string) {
    setCaps((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the role a name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!role) {
        const body: CreateRoleInput = {
          name: trimmed,
          color: color as CreateRoleInput['color'],
          capabilities: [...caps],
        };
        const created = await apiPost<Role>(`${base}/roles`, body, {
          idempotencyKey: crypto.randomUUID(),
        });
        onSaved(created);
      } else {
        const body: UpdateRoleInput = {
          name: trimmed,
          color: color as UpdateRoleInput['color'],
          ...(!system && { capabilities: [...caps] }),
        };
        // Optimistic: the row shows the change at once; the server's answer replaces it.
        onSaved({
          ...role,
          name: trimmed,
          color,
          capabilities: system ? role.capabilities : [...caps],
        });
        try {
          const saved = await apiSend<Role>(
            'PATCH',
            `${base}/roles/${encodeURIComponent(role.id)}`,
            body,
          );
          onSaved(saved);
        } catch (err) {
          onSaved(role);
          throw err;
        }
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!role || !onDeleted) return;
    if (!window.confirm(`Delete the ${role.name} role? Teammates keep their other roles.`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiSend<undefined>('DELETE', `${base}/roles/${encodeURIComponent(role.id)}`);
      onDeleted(role.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[10px] border border-line bg-raise p-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="min-w-[220px] flex-1">
          <span className="label">Role name</span>
          <input
            className="inp mt-1.5 h-10 w-full px-3 text-[14px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            readOnly={readOnly}
            placeholder="e.g. QA Engineer"
          />
        </label>
        <fieldset disabled={readOnly}>
          <legend className="label">Colour</legend>
          <div className="mt-1.5 flex gap-1.5">
            {ROLE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={`h-7 w-7 rounded-md border ${
                  color === c ? 'border-ink' : 'border-line'
                } flex items-center justify-center bg-panel`}
              >
                <span aria-hidden="true" className={`h-3.5 w-3.5 rounded-sm ${roleDot(c)}`} />
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      {system === 'owner' && (
        <p className="mt-4 text-[13px] text-muted">
          The Owner can always do everything. You can rename it.
        </p>
      )}
      {system === 'observer' && (
        <p className="mt-4 text-[13px] text-muted">Built-in role: you can rename it only.</p>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {GROUPS.map(({ group, items }) => (
          <fieldset key={group} disabled={capsLocked} className="min-w-0">
            <legend className="label">{group}</legend>
            <ul className="mt-1.5 space-y-1">
              {items.map((cap) => (
                <li key={cap.key}>
                  <label className="flex items-start gap-2 rounded-md px-1 py-1 text-[13px] hover:bg-panel">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={system === 'owner' || caps.has(cap.key)}
                      onChange={() => toggle(cap.key)}
                    />
                    <span className="min-w-0 flex-1 text-text">{cap.description}</span>
                    {cap.risk !== 'low' && (
                      <span className={`${RISK_CHIP[cap.risk]} shrink-0 px-1.5 text-[11px]`}>
                        {cap.risk} risk
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        ))}
      </div>

      {error && (
        <p role="alert" className="chip bad mt-4 px-3 py-2 text-[13px]">
          {error}
        </p>
      )}

      {!readOnly && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn pri h-9 px-4 text-[14px]"
            onClick={() => void save()}
            disabled={busy}
          >
            {role ? 'Save role' : 'Create role'}
          </button>
          <button type="button" className="btn ghost h-9 px-3 text-[14px]" onClick={onCancel}>
            Cancel
          </button>
          {role && !system && (
            <button
              type="button"
              className="btn ghost ml-auto h-9 px-3 text-[14px] text-bad"
              onClick={() => void remove()}
              disabled={busy}
            >
              Delete role
            </button>
          )}
        </div>
      )}
    </div>
  );
}
