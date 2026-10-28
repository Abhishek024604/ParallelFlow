import { z } from 'zod';
import { SDLC_STAGES, type SdlcStage } from './arenas.js';

// The SDLC loop: stage strip, gate requests and votes (build step 7; openapi_v2.yaml requestGate,
// sendBack, vote, getCycle, in their project-prefixed form, ADR-036).

const Uuid = z
  .string()
  .uuid('Must be a uuid')
  .transform((id) => id.toLowerCase());

export const GATE_REASON_MAX_CHARS = 2_000;
/** Days a gate request stays open. */
export const GATE_REQUEST_TTL_DAYS = 7;

/** The stage after `stage`, or null for MAINTAIN (the loop continues with a new cycle). */
export function nextStage(stage: SdlcStage): SdlcStage | null {
  const i = SDLC_STAGES.indexOf(stage);
  return SDLC_STAGES[i + 1] ?? null;
}

/** The stages before `stage`, oldest first (where Send back may go). */
export function earlierStages(stage: SdlcStage): SdlcStage[] {
  return SDLC_STAGES.slice(0, SDLC_STAGES.indexOf(stage));
}

/** POST /projects/{project_id}/cycles/{cycle_id}/gate-requests. `summary` is optional here. */
export const GateRequestSchema = z
  .object({
    summary: z.string().trim().max(GATE_REASON_MAX_CHARS).optional(),
    artifact_id: Uuid.optional(),
  })
  .strict();
export type GateRequestInput = z.input<typeof GateRequestSchema>;
export type GateRequest = z.output<typeof GateRequestSchema>;

/** POST /projects/{project_id}/approvals/{approval_id}/votes. Reject needs a reason. */
export const VoteSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(GATE_REASON_MAX_CHARS).optional(),
  })
  .strict()
  .refine((v) => v.decision === 'approve' || Boolean(v.reason), {
    message: 'Say why you are sending it back',
    path: ['reason'],
  });
export type VoteInput = z.input<typeof VoteSchema>;
export type Vote = z.output<typeof VoteSchema>;

/** POST /projects/{project_id}/cycles/{cycle_id}:send-back. Default: the stage before. */
export const SendBackSchema = z
  .object({
    to_stage: z.enum(SDLC_STAGES).optional(),
    reason: z
      .string()
      .trim()
      .min(5, 'At least 5 characters')
      .max(GATE_REASON_MAX_CHARS, `At most ${GATE_REASON_MAX_CHARS} characters`),
  })
  .strict();
export type SendBackInput = z.input<typeof SendBackSchema>;
export type SendBack = z.output<typeof SendBackSchema>;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

export interface LoopActor {
  type: 'user' | 'agent' | 'service';
  id: string;
  display_name: string;
}

export interface GateVote {
  user_id: string;
  display_name: string;
  decision: 'approve' | 'reject';
  reason: string | null;
  created_at: string;
}

/** A stage gate request (OpenAPI Approval, kind stage_gate). Its stream card has the same id. */
export interface GateApproval {
  id: string;
  cycle_id: string;
  cycle_number: number;
  stage: SdlcStage;
  /** Where approval moves the cycle. */
  to_stage: SdlcStage;
  title: string;
  status: ApprovalStatus;
  min_approvals: number;
  /** Role names that may approve. */
  approver_roles: string[];
  requested_by: LoopActor;
  votes: GateVote[];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

export interface LoopTransition {
  from_stage: SdlcStage | null;
  to_stage: SdlcStage;
  kind: 'advance' | 'send_back' | 'auto' | 'skip' | 'open';
  actor: LoopActor;
  reason: string | null;
  created_at: string;
}

/** GET /projects/{project_id}/cycles/current: what the stage strip and gate cards need. */
export interface LoopState {
  cycle: {
    id: string;
    number: number;
    title: string;
    stage: SdlcStage;
    status: 'active' | 'operating' | 'closed' | 'abandoned';
  } | null;
  /** The gate to leave the current stage; null in MAINTAIN or without a cycle. */
  gate: {
    stage: SdlcStage;
    mode: 'approval' | 'auto' | 'skip';
    approver_roles: string[];
    min_approvals: number;
    min_distinct_roles: number;
    forbid_self_approval: boolean;
  } | null;
  /** The open request of the current stage, if any. */
  pending: GateApproval | null;
  /** This cycle's gate requests, newest first (at most 20): live state for the stream cards. */
  approvals: GateApproval[];
  /** Newest first (at most 10). */
  transitions: LoopTransition[];
  viewer: {
    user_id: string;
    can_request_gate: boolean;
    /** Holds stage.approve.<stage> and one of the gate's approver roles. */
    can_approve: boolean;
  };
}

/** POST …/gate-requests, …/votes and …:send-back answer (the strip refetches the full state). */
export interface LoopActionResult {
  /** The gate request acted on (none for a Send back without an open request). */
  approval_id: string | null;
  approval_status: ApprovalStatus | null;
  /** Approve votes so far. */
  approvals: number;
  cycle_number: number;
  stage: SdlcStage;
  cycle_status: 'active' | 'operating' | 'closed' | 'abandoned';
}

// ---------------------------------------------------------------- arena repo (Phase A, additive)

/** GET /projects/{id}/repo: the arena's git repository (a commit per approved gate). */
export interface ArenaRepo {
  branch: string;
  /** Newest first. */
  commits: { sha: string; message: string; author: string; at: string }[];
  /** Files at the latest commit. */
  files: { path: string; size: number }[];
  /** The GitHub repository (https://github.com/owner/name) once connected (ADR-040); else null. */
  remote: string | null;
}
