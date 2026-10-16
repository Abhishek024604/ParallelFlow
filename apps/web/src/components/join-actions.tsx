'use client';

import type { AcceptInviteArena } from '@saras/contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost, ProblemError, signOut } from '../lib/api-browser';

// The join page's buttons: Join arena (POST /invites/{token}:accept) and Use another account (sign
// out, then sign in again and come back here).

export function JoinButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const joined = await apiPost<AcceptInviteArena>(`/invites/${token}:accept`);
            router.replace(`/arena/${joined.arena.id}`);
            router.refresh();
          } catch (err) {
            setError(
              err instanceof ProblemError
                ? err.code === 'INVITE_EXPIRED'
                  ? 'This invitation link has expired or was already used. Ask for a new one.'
                  : err.detail
                : 'Something went wrong. Please try again.',
            );
            setBusy(false);
          }
        }}
        className="btn pri h-12 w-full text-[15px]"
      >
        {busy ? 'Joining…' : 'Join arena'}
      </button>
      {error && (
        <p role="alert" className="chip bad mt-3 px-3 py-2 text-left text-[13px]">
          {error}
        </p>
      )}
    </>
  );
}

export function UseAnotherAccount({ signInPath }: { signInPath: string }) {
  return (
    <button
      type="button"
      onClick={() => void signOut(signInPath)}
      className="text-text underline decoration-line2 underline-offset-[3px] hover:text-acc-ink"
    >
      Use another account
    </button>
  );
}
