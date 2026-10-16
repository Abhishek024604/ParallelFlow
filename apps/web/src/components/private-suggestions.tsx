'use client';

import { type PrivateChat, uuidv7 } from '@saras/contracts';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiPost, ProblemError } from '../lib/api-browser';
import { SoonTip } from './soon';

// Suggestions under the Private home composer. "Bring context from an Arena" starts a chat and opens
// the arena picker (the bridge, step 6); the others need more of the AI and stay "Soon".

const SOON = ['Draft a goal.md', 'Review my plan.md'];

export function PrivateSuggestions() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bring = async () => {
    setBusy(true);
    setError(null);
    try {
      const chat = await apiPost<PrivateChat>(
        '/private/sessions',
        { title: 'Arena context' },
        { idempotencyKey: uuidv7() },
      );
      router.push(`/private/${chat.id}?bring=1`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ProblemError ? err.detail : 'Something went wrong. Please try again.',
      );
      setBusy(false);
    }
  };

  return (
    <>
      <ul className="mt-3 flex flex-wrap justify-center gap-2" aria-label="Suggestions">
        <li className="w-auto">
          <button
            type="button"
            className="btn h-9 px-3.5 text-[14px]"
            disabled={busy}
            onClick={() => void bring()}
          >
            Bring context from an Arena
          </button>
        </li>
        {SOON.map((label) => (
          <li key={label} className="w-auto">
            <SoonTip side="bottom">
              <button
                type="button"
                aria-disabled="true"
                className="btn h-9 cursor-not-allowed px-3.5 text-[14px] opacity-55"
              >
                {label}
              </button>
            </SoonTip>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-2 text-center text-[13px] text-bad">
          {error}
        </p>
      )}
    </>
  );
}
