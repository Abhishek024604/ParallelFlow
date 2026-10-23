'use client';

import {
  type ArenaDetail,
  type ArenaInvite,
  type ArenaJoinLink,
  type CreateInvitesResponse,
  InviteEmailSchema,
  MAX_INVITE_EMAILS,
  uuidv7,
} from '@parallelflow/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { apiPost, ProblemError } from '../lib/api-browser';
import { CopyButton } from './create-arena';

// Inviting teammates from inside an arena (Members tab; cap member.invite). Two ways in:
//   - the join link: anyone signed in who opens it joins as a Member (Reset makes a new one);
//   - email invites: one link per email, for that email only; emailed when the server has SMTP set
//     up, and copyable here while pending.
// Links are built from the address this page was opened from, so they work on whatever host the
// app is served at (localhost, a tunnel or a deploy).

const STATUS: Record<ArenaInvite['status'], { label: string; chip: string }> = {
  pending: { label: 'Waiting to join', chip: 'chip warn' },
  accepted: { label: 'Joined', chip: 'chip ok' },
  revoked: { label: 'Revoked', chip: 'chip' },
  expired: { label: 'Expired', chip: 'chip' },
};

function expiresIn(iso: string): string {
  const days = Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  return days <= 1 ? 'expires within a day' : `expires in ${days} days`;
}

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Please try again.';

/** `/join/<token>` on this page's own origin (empty during the server render). */
function useJoinUrl(): (token: string) => string {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  return (token) => `${origin}/join/${token}`;
}

function LinkRow({ url }: { url: string }) {
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        readOnly
        value={url}
        aria-label="Join link"
        onFocus={(e) => e.currentTarget.select()}
        className="inp h-8 min-w-0 flex-1 px-2 text-[12px] text-muted"
      />
      <CopyButton text={url} />
    </div>
  );
}

export function InvitePanel({ projectId, arena }: { projectId: string; arena: ArenaDetail }) {
  const router = useRouter();
  const joinUrl = useJoinUrl();
  const [joinLink, setJoinLink] = useState<ArenaJoinLink | null>(arena.join_link);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => setJoinLink(arena.join_link), [arena.join_link]);

  if (!arena.can_invite) return null;

  const resetLink = async () => {
    setBusy(true);
    setError(null);
    try {
      setJoinLink(
        await apiPost<ArenaJoinLink>(`/projects/${projectId}/join-link`, undefined, {
          idempotencyKey: uuidv7(),
        }),
      );
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const emails: string[] = [];
    for (const part of draft.split(/[\s,;]+/).filter(Boolean)) {
      const parsed = InviteEmailSchema.safeParse(part);
      if (!parsed.success) {
        setError(`"${part}" is not a valid email address.`);
        return;
      }
      emails.push(parsed.data);
    }
    if (!emails.length) {
      setError('Add at least one email.');
      return;
    }
    if (emails.length > MAX_INVITE_EMAILS) {
      setError(`You can invite up to ${MAX_INVITE_EMAILS} teammates at a time.`);
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<CreateInvitesResponse>(
        `/projects/${projectId}/invites`,
        { emails },
        { idempotencyKey: uuidv7() },
      );
      const made = result.invites.length;
      const emailed = result.invites.some((i) => i.emailed);
      const parts: string[] = [];
      if (made) {
        parts.push(
          emailed
            ? `Emailed ${made} ${made === 1 ? 'invite' : 'invites'}. You can also copy the links below.`
            : `Made ${made} invite ${made === 1 ? 'link' : 'links'}. Copy and send them below.`,
        );
      }
      if (result.already_members.length) {
        parts.push(`Already in this arena: ${result.already_members.join(', ')}.`);
      }
      setNotice(parts.join(' '));
      setDraft('');
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const live = joinLink && new Date(joinLink.expires_at).getTime() > Date.now() ? joinLink : null;
  const invites = arena.invites.filter((i) => i.status !== 'revoked');

  return (
    <section className="mb-8 space-y-5">
      <div>
        <h2 className="label">Invite teammates</h2>
        <div className="card mt-2 px-3 py-3">
          <p className="text-[13px] font-medium text-text">Join link</p>
          <p className="text-[12px] text-faint">
            Anyone who opens it and signs in joins as a Member.
          </p>
          {live ? (
            <>
              <LinkRow url={joinUrl(live.token)} />
              <p className="mt-1.5 text-[12px] text-faint">
                Link {expiresIn(live.expires_at)} ·{' '}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resetLink()}
                  className="underline decoration-line2 underline-offset-[3px] hover:text-text"
                >
                  Reset link
                </button>
              </p>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void resetLink()}
              className="btn mt-2 h-8 px-3 text-[13px]"
            >
              Create join link
            </button>
          )}
        </div>

        <form onSubmit={(e) => void invite(e)} className="card mt-2 px-3 py-3">
          <label htmlFor="invite-emails" className="text-[13px] font-medium text-text">
            Invite by email
          </label>
          <p className="text-[12px] text-faint">Each link works only for that email.</p>
          <div className="mt-2 flex gap-2">
            <input
              id="invite-emails"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="riya@example.com, karan@example.com"
              className="inp h-8 min-w-0 flex-1 px-2 text-[13px]"
            />
            <button type="submit" disabled={busy} className="btn h-8 shrink-0 px-3 text-[13px]">
              {busy ? 'Inviting…' : 'Invite'}
            </button>
          </div>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-bad">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-2 text-[12px] text-ok">
            {notice}
          </p>
        )}
      </div>

      {invites.length > 0 && (
        <div>
          <h2 className="label">Invites</h2>
          <ul className="card mt-2 divide-y divide-line">
            {invites.map((invite) => {
              const status = STATUS[invite.status];
              return (
                <li key={invite.id} className="px-3 py-2.5">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-text">
                        {invite.email}
                      </div>
                      {invite.status === 'pending' && (
                        <div className="text-[12px] text-faint">
                          Link {expiresIn(invite.expires_at)}
                        </div>
                      )}
                    </div>
                    <span className={`${status.chip} px-2 py-0.5 text-[12px]`}>{status.label}</span>
                  </div>
                  {invite.status === 'pending' &&
                    (invite.token ? (
                      <LinkRow url={joinUrl(invite.token)} />
                    ) : (
                      <p className="mt-1 text-[12px] text-faint">
                        This older link can&rsquo;t be shown again. Invite the email again for a new
                        one.
                      </p>
                    ))}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
