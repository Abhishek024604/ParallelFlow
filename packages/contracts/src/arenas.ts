import { z } from 'zod';

// Arenas and invite links (ADR-029; openapi_v2.yaml: /arenas, /arenas/{arena_id}, /invites/{token},
// /invites/{token}:accept). An arena is, under the hood, a hidden org + team + project + arena + AI
// session; the API speaks only of arenas, so no field here says "org".

export const MAX_INVITE_EMAILS = 20;
export const INVITE_TTL_DAYS = 7;

/** One invite email: trimmed, lower-cased, a plausible address. */
export const InviteEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320, 'At most 320 characters')
  .email('Enter a valid email address');

/** POST /arenas body. Duplicate emails are dropped; the creator's own email is dropped server side. */
export const CreateArenaSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the arena a name').max(80, 'At most 80 characters'),
    description: z
      .string()
      .trim()
      .max(500, 'At most 500 characters')
      .optional()
      .transform((value) => (value ? value : undefined)),
    invite_emails: z
      .array(InviteEmailSchema)
      .max(MAX_INVITE_EMAILS, `At most ${MAX_INVITE_EMAILS} teammates at a time`)
      .optional()
      .transform((emails) => [...new Set(emails ?? [])]),
  })
  .strict();
export type CreateArenaInput = z.input<typeof CreateArenaSchema>;
export type CreateArena = z.output<typeof CreateArenaSchema>;

export const SDLC_STAGES = ['PLAN', 'DESIGN', 'BUILD', 'TEST', 'DEPLOY', 'MAINTAIN'] as const;
export type SdlcStage = (typeof SDLC_STAGES)[number];

/** One arena as its members see it in lists. `id` is the arena's project id. */
export interface ArenaSummary {
  id: string;
  arena_id: string;
  name: string;
  description: string | null;
  /** 2–4 upper-case letters, e.g. "IPP". */
  key: string;
  /** Number of the active cycle, or null when none is active. */
  cycle: number | null;
  stage: SdlcStage | null;
  member_count: number;
  /** Your role here: the arena owner, or a member. */
  role: 'owner' | 'member';
}

export interface ArenaList {
  items: ArenaSummary[];
}

/** An invite link, returned once by POST /arenas. `link` is null on an idempotent replay. */
export interface CreatedInvite {
  email: string;
  link: string | null;
}

export interface CreateArenaResponse extends ArenaSummary {
  invites: CreatedInvite[];
}

/** A pending or past invite, as the arena owner sees it. Never carries the link. */
export interface ArenaInvite {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
}

export interface ArenaDetail extends ArenaSummary {
  /** Owner only; empty for members. */
  invites: ArenaInvite[];
}

/** GET /invites/{token}: what the join page shows. */
export interface InvitePreview {
  arena: {
    name: string;
    description: string | null;
    member_count: number;
    /** Initials of up to four members, for the avatar stack. */
    member_initials: string[];
  };
  invited_by: { display_name: string };
  /** The invited email, masked (r***@example.com) unless you are signed in as that email. */
  email: string;
  /** null when you are not signed in. */
  email_matches: boolean | null;
  expires_at: string;
}

/** POST /invites/{token}:accept returns your profile (Me) plus the arena you joined. */
export interface AcceptInviteArena {
  arena: { id: string; name: string };
}

// ---------------------------------------------------------------- invite tokens
// `<org id>.<secret>`: the org id routes the lookup to one tenant; the secret is 32 random bytes,
// base64url (43 characters). Only SHA-256(secret) is stored.

export const INVITE_SECRET_BYTES = 32;
const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const INVITE_TOKEN_PATTERN = new RegExp(`^(${UUID_PART})\\.([A-Za-z0-9_-]{43})$`);
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export interface InviteToken {
  orgId: string;
  secret: string;
}

/** Strict parse; anything else (wrong length, upper-case id, nil id, padding) is null. */
export function parseInviteToken(token: unknown): InviteToken | null {
  if (typeof token !== 'string' || token.length > 100) return null;
  const match = INVITE_TOKEN_PATTERN.exec(token);
  if (!match || !match[1] || !match[2] || match[1] === NIL_UUID) return null;
  return { orgId: match[1], secret: match[2] };
}

export function formatInviteToken(orgId: string, secret: string): string {
  const token = `${orgId.toLowerCase()}.${secret}`;
  if (!parseInviteToken(token)) throw new Error('Invalid invite token parts');
  return token;
}
