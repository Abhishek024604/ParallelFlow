'use client';

import {
  type Artifact,
  type ArtifactList,
  type ChatMessage,
  earlierStages,
  type GateApproval,
  type LoopActionResult,
  type LoopState,
  SDLC_STAGES,
  type SdlcStage,
  uuidv7,
} from '@parallelflow/contracts';
import { useRouter } from 'next/navigation';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { apiGet, apiPost, ProblemError } from '../lib/api-browser';
import { timeLabel } from '../lib/chat';
import { applyVote, approvalsOf, movesLabel, waitingLabel } from '../lib/loop';
import { CheckIcon, FlagIcon, LoopIcon } from './icons';

// The SDLC loop in the arena (screen 04, build step 7): the stage strip under the header, the
// "Request <STAGE> gate" action, and the gate cards in the stream. One provider holds the loop state
// (rendered by the server, then fetched every 5 s while the tab is visible and right after every
// action); a vote shows at once (optimistic) and the server's answer replaces it. Only people vote:
// the API refuses anyone who is not a gate approver, and checks self-approval and min_approvals.

const POLL_MS = 5_000;

const statePath = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/cycles/current`;

const errorText = (err: unknown, fallback: string) =>
  err instanceof ProblemError ? (err.fieldErrors[0]?.message ?? err.detail ?? fallback) : fallback;

interface LoopApi {
  projectId: string;
  state: LoopState;
  /** `artifactId`: the document this gate approves (optional). */
  requestGate: (artifactId?: string) => Promise<void>;
  vote: (approvalId: string, decision: 'approve' | 'reject', reason?: string) => Promise<void>;
  sendBack: (toStage: SdlcStage, reason: string) => Promise<void>;
}

const LoopContext = createContext<LoopApi | null>(null);

export function LoopProvider({
  projectId,
  initial,
  children,
}: {
  projectId: string;
  initial: LoopState;
  children: ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const stage = useRef(initial.cycle?.stage);

  const refresh = useCallback(async () => {
    try {
      setState(await apiGet<LoopState>(statePath(projectId)));
    } catch {
      // The next poll tries again.
    }
  }, [projectId]);

  // A stage move refreshes the server parts of the page (header, sidebar).
  useEffect(() => {
    if (state.cycle?.stage !== stage.current) {
      stage.current = state.cycle?.stage;
      router.refresh();
    }
  }, [state.cycle?.stage, router]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const api: Omit<LoopApi, 'projectId'> = {
    state,
    requestGate: async (artifactId) => {
      const cycle = state.cycle;
      if (!cycle) return;
      await apiPost<LoopActionResult>(
        `/projects/${encodeURIComponent(projectId)}/cycles/${encodeURIComponent(cycle.id)}/gate-requests`,
        artifactId ? { artifact_id: artifactId } : {},
        { idempotencyKey: uuidv7() },
      );
      await refresh();
    },
    vote: async (approvalId, decision, reason) => {
      const before = state;
      setState((s) => applyVote(s, approvalId, decision, reason ?? null));
      try {
        await apiPost<LoopActionResult>(
          `/projects/${encodeURIComponent(projectId)}/approvals/${encodeURIComponent(approvalId)}/votes`,
          { decision, ...(reason && { reason }) },
          { idempotencyKey: uuidv7() },
        );
      } catch (err) {
        setState(before);
        throw err;
      }
      await refresh();
    },
    sendBack: async (toStage, reason) => {
      const cycle = state.cycle;
      if (!cycle) return;
      await apiPost<LoopActionResult>(
        `/projects/${encodeURIComponent(projectId)}/cycles/${encodeURIComponent(cycle.id)}:send-back`,
        { to_stage: toStage, reason },
        { idempotencyKey: uuidv7() },
      );
      await refresh();
    },
  };
  return <LoopContext.Provider value={{ ...api, projectId }}>{children}</LoopContext.Provider>;
}

const useLoop = () => useContext(LoopContext);

/** Cycle N, PLAN … MAINTAIN with the current stage, and the gate chip or the request action. */
export function StageStrip() {
  const loop = useLoop();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Picking the document this gate approves (optional): the arena's files.
  const [docs, setDocs] = useState<Artifact[] | null>(null);
  const [doc, setDoc] = useState('');
  if (!loop?.state.cycle) return null;
  const { cycle, pending, viewer, gate } = loop.state;

  const choose = async () => {
    setError(null);
    try {
      const list = await apiGet<ArtifactList>(
        `/projects/${encodeURIComponent(loop.projectId)}/artifacts`,
      );
      setDocs(list.items);
      setDoc(list.items[0]?.id ?? '');
    } catch (err) {
      setError(errorText(err, 'Could not load the arena files. Please try again.'));
    }
  };

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await loop.requestGate(doc || undefined);
      setDocs(null);
    } catch (err) {
      setError(errorText(err, 'Could not request the gate. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-b border-line px-6 py-3">
      <div className="flex items-center gap-4">
        <span className="flex shrink-0 items-center gap-2 text-[14px] font-semibold text-text">
          <LoopIcon className="text-acc-ink" />
          Cycle {cycle.number}
        </span>
        <ol aria-label="Stages" className="flex min-w-0 flex-1 gap-2 overflow-hidden">
          {SDLC_STAGES.map((stage) => {
            const current = stage === cycle.stage;
            return (
              <li
                key={stage}
                aria-current={current ? 'step' : undefined}
                className={`min-w-0 flex-1 border-t-[3px] pt-1.5 text-[12px] ${
                  current ? 'border-acc font-semibold text-acc-ink' : 'border-line text-faint'
                }`}
              >
                <span className="block truncate">{stage}</span>
              </li>
            );
          })}
        </ol>
        {pending ? (
          <span className="chip acc shrink-0 px-2.5 py-1 text-[12px]" role="status">
            {waitingLabel(pending)}
          </span>
        ) : cycle.status === 'operating' ? (
          <span className="chip ok shrink-0 px-2.5 py-1 text-[12px]">Operating</span>
        ) : viewer.can_request_gate && gate ? (
          <button
            type="button"
            className="btn h-8 shrink-0 gap-2 px-3 text-[13px]"
            onClick={() => (docs ? setDocs(null) : void choose())}
            disabled={busy}
            aria-expanded={docs !== null}
          >
            <FlagIcon size={14} />
            {`Request ${cycle.stage} gate`}
          </button>
        ) : null}
      </div>
      {docs && !pending && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-[13px]">
          <label htmlFor="gate-doc" className="text-muted">
            Document to approve
          </label>
          <select
            id="gate-doc"
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
            className="inp h-8 max-w-[280px] px-1.5 text-[13px] text-text"
          >
            <option value="">None (just move the stage)</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · v{d.head_version_no}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn pri h-8 px-3 text-[13px]"
            onClick={() => void request()}
            disabled={busy}
          >
            {busy ? 'Requesting…' : 'Send request'}
          </button>
          <button
            type="button"
            className="btn ghost h-8 px-2 text-[13px]"
            onClick={() => setDocs(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-right text-[12px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

const STATUS_CHIP: Record<GateApproval['status'], (a: GateApproval) => [string, string]> = {
  pending: (a) => ['chip acc', `${approvalsOf(a)} of ${a.min_approvals} approvals`],
  approved: () => ['chip ok', 'Approved'],
  rejected: () => ['chip bad', 'Sent back'],
  cancelled: () => ['chip', 'Sent back'],
  expired: () => ['chip', 'Expired'],
};

/** A gate card in the arena stream (same id as its gate request); live state from the provider. */
export function GateCard({ message }: { message: ChatMessage }) {
  const loop = useLoop();
  const approval = loop?.state.approvals.find((a) => a.id === message.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [reason, setReason] = useState('');
  const [toStage, setToStage] = useState<SdlcStage | ''>('');

  const header = (chip: [string, string] | null) => (
    <div className="flex items-center gap-3 border-b border-line bg-raise px-4 py-3">
      <FlagIcon className="shrink-0 text-acc-ink" />
      <p className="min-w-0 flex-1 truncate text-[14px] text-text">
        <span className="font-semibold">
          {approval ? `${approval.stage} gate requested` : message.body}
        </span>{' '}
        <span className="text-[12px] text-faint">
          {approval ? `by ${approval.requested_by.display_name} · ` : ''}
          <time dateTime={message.created_at}>{timeLabel(message.created_at)}</time>
        </span>
      </p>
      {chip && <span className={`${chip[0]} shrink-0 px-2 py-0.5 text-[12px]`}>{chip[1]}</span>}
    </div>
  );

  // An older cycle's request: the text only.
  if (!loop || !approval) {
    return <li className="card overflow-hidden">{header(null)}</li>;
  }

  const { viewer, gate } = loop.state;
  const voted = approval.votes.some((v) => v.user_id === viewer.user_id);
  const selfBlocked =
    Boolean(gate?.forbid_self_approval) && approval.requested_by.id === viewer.user_id;
  const canAct = approval.status === 'pending' && viewer.can_approve && !voted;
  const earlier = earlierStages(approval.stage);
  const sentBackVote = approval.votes.find((v) => v.decision === 'reject');

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSending(false);
      setReason('');
    } catch (err) {
      setError(errorText(err, 'That did not work. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  // Send back: a reject vote (the cycle stays), or with an earlier stage the cycle goes back to it.
  const confirmSendBack = () =>
    act(async () => {
      const why = reason.trim();
      if (!why) return;
      if (toStage) await loop.sendBack(toStage, why);
      else await loop.vote(approval.id, 'reject', why);
    });

  return (
    <li className="card overflow-hidden">
      {header(STATUS_CHIP[approval.status](approval))}
      <div className="space-y-3 px-4 py-3">
        <p className="text-[14px] text-text">{movesLabel(approval)}.</p>
        {approval.status === 'approved' && (
          <p className="text-[13px] text-ok">
            Approved by{' '}
            {approval.votes
              .filter((v) => v.decision === 'approve')
              .map((v) => v.display_name)
              .join(', ')}
            . Cycle {approval.cycle_number} moved to {approval.to_stage}.
          </p>
        )}
        {sentBackVote && (
          <p className="text-[13px] text-muted">
            Sent back by {sentBackVote.display_name}: {sentBackVote.reason}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-faint">Approvers:</span>
          {approval.approver_roles.map((role) => (
            <span key={role} className="chip acc px-2 py-0.5 text-[12px]">
              {role}
            </span>
          ))}
          {canAct && !sending && (
            <span className="ml-auto flex gap-2">
              <button
                type="button"
                className="btn h-9 px-3 text-[14px]"
                onClick={() => setSending(true)}
                disabled={busy}
              >
                Send back
              </button>
              <button
                type="button"
                className="btn pri h-9 gap-2 px-4 text-[14px]"
                onClick={() => void act(() => loop.vote(approval.id, 'approve'))}
                disabled={busy || selfBlocked}
                title={
                  selfBlocked
                    ? 'You requested this gate: another approver must approve it.'
                    : undefined
                }
              >
                <CheckIcon />
                Approve
              </button>
            </span>
          )}
        </div>
        {canAct && selfBlocked && (
          <p className="text-[12px] text-faint">
            You requested this gate, so another approver must approve it.
          </p>
        )}
        {sending && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void confirmSendBack();
            }}
          >
            <label className="block text-[13px] text-muted" htmlFor={`why-${approval.id}`}>
              Comment (required to send back)
            </label>
            <textarea
              id={`why-${approval.id}`}
              className="inp w-full border px-3 py-2 text-[14px]"
              rows={2}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
            <div className="flex flex-wrap items-center gap-2">
              {earlier.length > 0 && (
                <label className="flex items-center gap-2 text-[13px] text-muted">
                  Move the cycle back to
                  <select
                    className="sel border px-2 py-1 text-[13px]"
                    value={toStage}
                    onChange={(e) => setToStage(e.target.value as SdlcStage | '')}
                  >
                    <option value="">Stay in {approval.stage}</option>
                    {earlier.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  className="btn ghost h-9 px-3 text-[14px]"
                  onClick={() => setSending(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn h-9 px-3 text-[14px]"
                  disabled={busy || !reason.trim()}
                >
                  Send back
                </button>
              </span>
            </div>
          </form>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-bad">
            {error}
          </p>
        )}
      </div>
    </li>
  );
}
