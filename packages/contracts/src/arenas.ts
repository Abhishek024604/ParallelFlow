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

/** An IANA time zone this runtime knows ("Asia/Kolkata", "UTC"). */
export function isTimeZone(value: string): boolean {
  if (!/^[A-Za-z0-9_+/-]{1,64}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The arena's day ends at midnight in this zone (ADR-045: the nightly STATE.md chapter). */
export const TimeZoneSchema = z
  .string()
  .trim()
  .refine(isTimeZone, 'Pick a time zone from the list');

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
    /** The creator's browser time zone (the arena's day ends there); UTC when missing. */
    timezone: TimeZoneSchema.optional(),
  })
  .strict();
export type CreateArenaInput = z.input<typeof CreateArenaSchema>;
export type CreateArena = z.output<typeof CreateArenaSchema>;

/** PATCH /arenas/{id} (owner): rename, or change the description (null clears it). */
export const UpdateArenaSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Give the arena a name')
      .max(80, 'At most 80 characters')
      .optional(),
    description: z.string().trim().max(500, 'At most 500 characters').nullable().optional(),
    timezone: TimeZoneSchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.description !== undefined || v.timezone !== undefined,
    'Nothing to change',
  );
export type UpdateArenaInput = z.input<typeof UpdateArenaSchema>;
export type UpdateArena = z.output<typeof UpdateArenaSchema>;

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
  /** Archived arenas are read-only until the owner unarchives them. */
  archived: boolean;
  /** IANA zone the arena's day ends in (the nightly STATE.md chapter, ADR-045). */
  timezone: string;
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

/** A pending or past invite, as people who may invite see it. */
export interface ArenaInvite {
  id: string;
  email: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  /**
   * The join token (`/join/<token>`) of a pending invite, so its link can be copied again. Null for
   * used or expired invites and for invites made before links could be shown again.
   */
  token: string | null;
}

/**
 * The arena's open join link: anyone signed in who opens it joins as a Member until it expires or
 * is reset. Many people can use it.
 */
export interface ArenaJoinLink {
  token: string;
  expires_at: string;
}

export interface ArenaDetail extends ArenaSummary {
  /** Only for people who may invite (member.invite); empty otherwise. Email invites only. */
  invites: ArenaInvite[];
  /** Only for people who may invite. Null when there is no live join link. */
  join_link: ArenaJoinLink | null;
  /** Whether you may invite teammates here (member.invite). */
  can_invite: boolean;
}

/** POST /projects/{id}/invites body: invite these emails (existing members are skipped). */
export const CreateInvitesSchema = z
  .object({
    emails: z
      .array(InviteEmailSchema)
      .min(1, 'Add at least one email')
      .max(MAX_INVITE_EMAILS, `At most ${MAX_INVITE_EMAILS} teammates at a time`)
      .transform((emails) => [...new Set(emails)]),
  })
  .strict();
export type CreateInvites = z.output<typeof CreateInvitesSchema>;

export interface CreateInvitesResponse {
  /** One per new invite. `emailed` = an email went out (when mail is set up on the server). */
  invites: { email: string; token: string; emailed: boolean }[];
  /** Emails skipped because they already belong to a member. */
  already_members: string[];
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
  /** The arena's open join link: any signed-in account can join (`email` is empty). */
  open: boolean;
}

/** POST /invites/{token}:accept returns your profile (Me) plus the arena you joined. */
export interface AcceptInviteArena {
  arena: { id: string; name: string };
}

/**
 * The invitations.email of an open join link (schema_v2 requires an email). `.invalid` is reserved
 * (RFC 2606), so no real account can ever have it.
 */
export const OPEN_INVITE_EMAIL = 'anyone@join-link.invalid';

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
