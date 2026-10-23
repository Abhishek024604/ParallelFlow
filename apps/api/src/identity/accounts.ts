import type { Database } from '@parallelflow/db';
import { displayNameFor, handleBase, handleCandidate } from './handle.js';
import type { IdpUser } from './identity-provider.js';

// Sign-in → our account (ADR-029, ADR-031). Runs in identity scope (`withIdentity`), which can only
// read, create or update the account of the email the provider verified. Accounts are matched by
// that email; the WorkOS user id is not stored yet (SLICE_DEBT).

export type SignInResult = { status: 'ok'; userId: string } | { status: 'deactivated' };

/** Handle collisions are retried with a random suffix; more than this means something is wrong. */
const HANDLE_ATTEMPTS = 6;

export async function signInAccount(db: Database, user: IdpUser, now: Date): Promise<SignInResult> {
  const email = user.email.trim().toLowerCase();
  return db.withIdentity({ email }, async (tx) => {
    const existing = await tx
      .selectFrom('users')
      .select(['id', 'deactivated_at'])
      .where('email', '=', email)
      .executeTakeFirst();
    if (existing) {
      if (existing.deactivated_at) return { status: 'deactivated' } as const;
      await tx
        .updateTable('users')
        .set({ last_active_at: now })
        .where('id', '=', existing.id)
        .execute();
      return { status: 'ok', userId: existing.id } as const;
    }

    const base = handleBase(email);
    const displayName = displayNameFor({ ...user, email });
    for (let attempt = 0; attempt < HANDLE_ATTEMPTS; attempt++) {
      // DO NOTHING on any unique conflict (email or handle) keeps the transaction usable.
      const created = await tx
        .insertInto('users')
        .values({
          email,
          display_name: displayName,
          handle: handleCandidate(base, attempt),
          last_active_at: now,
        })
        .onConflict((oc) => oc.doNothing())
        .returning('id')
        .executeTakeFirst();
      if (created) return { status: 'ok', userId: created.id } as const;

      // A concurrent first login for the same email won the race: use that account.
      const raced = await tx
        .selectFrom('users')
        .select(['id', 'deactivated_at'])
        .where('email', '=', email)
        .executeTakeFirst();
      if (raced) {
        return raced.deactivated_at
          ? ({ status: 'deactivated' } as const)
          : ({ status: 'ok', userId: raced.id } as const);
      }
      // Otherwise the handle is taken: try another.
    }
    throw new Error('Could not allocate a unique handle');
  });
}
