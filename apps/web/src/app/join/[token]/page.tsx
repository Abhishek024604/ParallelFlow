import { parseInviteToken } from '@saras/contracts';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from '../../../components/brand';
import { InfoIcon } from '../../../components/icons';
import { JoinButton, UseAnotherAccount } from '../../../components/join-actions';
import { getInvite, getMe } from '../../../lib/api-server';
import { loginUrl, signInPath } from '../../../lib/paths';

export const metadata = { title: 'Join an arena · Saras' };

// Join an arena from an invite link (screen 20). No top bar. States: signed out (sign up or log in
// with the invited email, then come back), signed in as the invited email (Join arena), signed in
// as someone else (use another account), and an invalid, expired or used link.

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh px-6 py-7 sm:px-[120px]">
      <Link href="/" className="no-underline" aria-label="Saras">
        <Logo size={40} />
      </Link>
      <main className="mx-auto mt-10 w-full max-w-[480px]">{children}</main>
    </div>
  );
}

function daysLeft(iso: string): number {
  return Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export default async function JoinPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = parseInviteToken(token) !== null;
  const [invite, me] = await Promise.all([valid ? getInvite(token) : null, getMe()]);
  const here = `/join/${token}`;

  if (!invite) {
    return (
      <Shell>
        <div className="card px-8 py-10 text-center">
          <h1 className="text-[22px] font-bold text-text">This invitation can&rsquo;t be used</h1>
          <p className="mt-3 text-muted">
            The link has expired, was already used, or isn&rsquo;t complete. Ask the person who
            invited you for a new link.
          </p>
          <Link href="/" className="btn mt-6 h-10 px-4">
            Go to Saras
          </Link>
        </div>
      </Shell>
    );
  }

  const { arena } = invite;
  const members = `${arena.member_count} ${arena.member_count === 1 ? 'member' : 'members'}`;
  const days = daysLeft(invite.expires_at);

  return (
    <Shell>
      <div className="card px-3.5 pb-8 pt-8 text-center shadow-card">
        {arena.member_initials.length > 0 && (
          <div className="flex justify-center" aria-hidden="true">
            {arena.member_initials.map((initials, i) => (
              <span
                key={`${initials}-${i}`}
                className="av -ml-2 inline-flex h-10 w-10 items-center justify-center rounded-full text-[12px] ring-2 ring-panel first:ml-0"
              >
                {initials}
              </span>
            ))}
          </div>
        )}
        <p className="mt-4 text-muted">
          <span className="font-semibold text-text">{invite.invited_by.display_name}</span> invited
          you to join
        </p>
        <h1 className="mt-3 text-[30px] font-bold text-text">{arena.name}</h1>
        {arena.description && <p className="mt-4 px-6 text-muted">{arena.description}</p>}
        <p className="mt-4 text-[13px] text-faint">{members} · AI included</p>

        <div className="mt-6">
          {!me ? (
            <Link href={signInPath(here)} className="btn pri h-12 w-full text-[15px]">
              Join arena
            </Link>
          ) : invite.email_matches ? (
            <JoinButton token={token} />
          ) : (
            <p className="chip warn px-3 py-2.5 text-[13px]">
              This invite is for {invite.email}. You&rsquo;re signed in with a different email.
            </p>
          )}
        </div>

        {me && (
          <p className="mt-4 text-[13px] text-muted">
            Signed in as <span className="font-medium text-text">{me.email}</span> ·{' '}
            <UseAnotherAccount signInPath={signInPath(here)} />
          </p>
        )}
      </div>

      {!me && (
        <div className="mt-10 flex gap-3 rounded-[10px] border border-line bg-side px-5 py-4 text-left text-muted">
          <InfoIcon size={17} className="mt-0.5 shrink-0" />
          <p>
            New to Saras?{' '}
            <a href={loginUrl({ returnTo: here, screen: 'sign-up' })}>
              {invite.open ? 'Sign up' : `Sign up with ${invite.email}`}
            </a>{' '}
            first. You&rsquo;ll come straight back here to join.
          </p>
        </div>
      )}

      <p className="mt-12 text-center text-[13px] text-faint">
        This invitation expires in {days} {days === 1 ? 'day' : 'days'}.
      </p>
    </Shell>
  );
}
