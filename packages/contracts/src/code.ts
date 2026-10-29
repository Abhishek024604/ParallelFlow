import { z } from 'zod';

// The VS Code extension and code review (ADR-037): device sign-in, extension tokens, AI coding
// sessions on `ai/*` branches of the arena repo, pull requests into main and their reviews.
// Additive to openapi_v2.yaml (Phase A).

// ---------------------------------------------------------------- device sign-in (RFC 8628 style)

/** Seconds a device code lives. */
export const DEVICE_CODE_TTL_S = 600;
/** Seconds the extension waits between polls. */
export const DEVICE_POLL_INTERVAL_S = 5;
/** Every extension access token starts with this. */
export const EXT_TOKEN_PREFIX = 'parallelflow_ext_';
/** Days an extension access token lives. */
export const EXT_TOKEN_TTL_DAYS = 30;

export const DeviceCodeRequestSchema = z.object({
  client_name: z.string().trim().min(1).max(80).default('VS Code'),
});
export type DeviceCodeRequest = z.output<typeof DeviceCodeRequestSchema>;

export interface DeviceCodeResponse {
  device_code: string;
  /** Shown as XXXX-XXXX. */
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

/**
 * POST /ext/handoff (signed-in web session only): a device code that is already approved for you,
 * for "Build in VS Code". The web page hands it to the extension in a vscode:// link; the extension
 * exchanges it once at /ext/device/token, so there is no code to type.
 */
export interface ExtHandoff {
  device_code: string;
  expires_in: number;
}

/** The extension's id in VS Code (publisher.name of the packaged .vsix, apps/vscode/scripts/package.mjs). */
export const VSCODE_EXTENSION_ID = 'parallelflow.parallelflow-vscode';

/** vscode://…/start: opens an arena in VS Code (the extension's URI handler). */
export function vscodeStartLink(input: { arenaId: string; code: string; web: string }): string {
  const q = new URLSearchParams({ arena: input.arenaId, code: input.code, web: input.web });
  return `vscode://${VSCODE_EXTENSION_ID}/start?${q.toString()}`;
}

export const DeviceTokenRequestSchema = z.object({
  device_code: z.string().min(1).max(200),
});

export type DeviceTokenError =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | 'invalid_grant'
  | 'invalid_request';

export interface DeviceTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  /** Seconds. */
  expires_in: number;
  user: { id: string; display_name: string; email: string };
}

export const DeviceApproveSchema = z.object({
  user_code: z.string().trim().min(1).max(20),
  decision: z.enum(['approve', 'deny']),
});
export type DeviceApprove = z.output<typeof DeviceApproveSchema>;

/** GET /ext/device?user_code=: what the person is about to allow. */
export interface DeviceLookup {
  user_code: string;
  client_name: string;
  expires_at: string;
}

/** A connected app (Settings · Connected apps). The token itself is never shown again. */
export interface ExtToken {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string;
}

// ---------------------------------------------------------------- coding sessions

export const CODING_SESSION_STATUSES = ['active', 'pushed', 'done', 'abandoned'] as const;
export type CodingSessionStatus = (typeof CODING_SESSION_STATUSES)[number];

export const CreateCodingSessionSchema = z.object({
  title: z.string().trim().min(1, 'Give the task a title').max(200),
  description: z.string().trim().max(4000).default(''),
});
export type CreateCodingSession = z.output<typeof CreateCodingSessionSchema>;

export interface CodingSession {
  id: string;
  project_id: string;
  title: string;
  description: string;
  branch: string;
  base_sha: string;
  head_sha: string | null;
  status: CodingSessionStatus;
  started_by: string;
  /** The arena message that announced it (thread root of its events). */
  message_id: string | null;
  created_at: string;
  updated_at: string;
}

export const CODING_EVENT_KINDS = ['progress', 'tests', 'blocked', 'done'] as const;
export type CodingEventKind = (typeof CODING_EVENT_KINDS)[number];

export const CodingEventSchema = z.object({
  kind: z.enum(CODING_EVENT_KINDS),
  summary: z.string().trim().min(1).max(500),
});
export type CodingEvent = z.output<typeof CodingEventSchema>;

export interface CodingPushResult {
  branch: string;
  head_sha: string;
  /** The open PR of this session, updated to the new head; null before one is opened. */
  pull_request: { number: number; status: PullRequestStatus } | null;
}

// ---------------------------------------------------------------- pull requests

export const PULL_REQUEST_STATUSES = [
  'open',
  'approved',
  'changes_requested',
  'merged',
  'closed',
] as const;
export type PullRequestStatus = (typeof PULL_REQUEST_STATUSES)[number];

export const CreatePullRequestSchema = z.object({
  coding_session_id: z.string().uuid(),
  title: z.string().trim().min(1, 'Give the pull request a title').max(200),
  description: z.string().trim().max(20000).default(''),
});
export type CreatePullRequest = z.output<typeof CreatePullRequestSchema>;

export const REVIEW_DECISIONS = ['approve', 'request_changes', 'comment'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export const CreateReviewSchema = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    body: z.string().trim().max(10000).default(''),
  })
  .refine((r) => r.decision === 'approve' || r.body.length > 0, {
    message: 'Say what should change',
    path: ['body'],
  });
export type CreateReview = z.output<typeof CreateReviewSchema>;

export interface PersonRef {
  id: string;
  display_name: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  status: PullRequestStatus;
  branch: string;
  head_sha: string;
  author: PersonRef;
  author_kind: 'human' | 'ai';
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  /**
   * Set for a pull request on the arena's GitHub repository (ADR-042): a mirror of GitHub, where it
   * is reviewed and merged. Null for an in-app pull request.
   */
  github: GithubPullRef | null;
}

export type GithubPullState = 'open' | 'draft' | 'closed' | 'merged';

export interface GithubPullRef {
  number: number;
  html_url: string;
  state: GithubPullState;
  /** The GitHub account that opened it, or null when GitHub no longer names one. */
  author_login: string | null;
}

export interface PullRequestList {
  items: PullRequestSummary[];
}

export interface PullCommit {
  sha: string;
  message: string;
  author: string;
  at: string;
}

export interface PullFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  /** Unified diff of this file; null for binary files or when the diff was cut. */
  patch: string | null;
  truncated: boolean;
}

export interface PullReview {
  id: string;
  reviewer: PersonRef;
  decision: ReviewDecision;
  body: string;
  head_sha: string;
  created_at: string;
}

export interface PullRequestDetail extends PullRequestSummary {
  description: string;
  base: 'main';
  merged_by: PersonRef | null;
  merge_sha: string | null;
  coding_session: { id: string; title: string } | null;
  commits: PullCommit[];
  files: PullFile[];
  /** The whole diff was larger than the cap; some files have no patch. */
  diff_truncated: boolean;
  reviews: PullReview[];
  viewer: {
    is_author: boolean;
    can_review: boolean;
    can_approve: boolean;
    can_merge: boolean;
    can_close: boolean;
  };
  /** Why Merge is not available yet, or null when it is. */
  merge_blocker: string | null;
}

export interface BranchSummary {
  name: string;
  head_sha: string;
  updated_at: string;
  /** Commits on the branch that main does not have. */
  ahead: number;
  pull_request: { number: number; status: PullRequestStatus } | null;
}

export interface BranchList {
  items: BranchSummary[];
}
