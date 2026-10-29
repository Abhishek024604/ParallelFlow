// Messages between the extension host and the chat webviews (sidebar and editor tab).
import type { ApprovalRequest } from '../approvals/broker.js';
import type { TranscriptItem } from '../pi/transcript.js';
import type { AgentMode } from './agent-config.js';

export type Isolation = 'container' | 'host' | 'host-container-available';
export type AgentStatus = 'off' | 'starting' | 'idle' | 'working' | 'waiting' | 'error';

export interface TaskView {
  id: string;
  title: string;
  branch: string;
  baseSha: string;
  projectId: string;
  pushed: boolean;
  pr?: { number: number; link: string };
  /** Set when the task builds on the arena's GitHub repository (ADR-042). */
  github?: {
    fullName: string;
    defaultBranch: string;
    storyId?: string;
    storyPath?: string;
  };
}

/** Architect mode: the SWA gates of arch/ (ui/architect.ts). */
export interface ArchitectView {
  inputs: { present: string[]; missing: string[] };
  gates: {
    key: string;
    state: 'approved' | 'open' | 'empty';
    files: { path: string; state: 'approved' | 'changed' | 'stale' | 'draft' }[];
    missing: string[];
    /** Every file is there and something is not approved yet. */
    approvable: boolean;
  }[];
  next: string;
  /** .drawio and .excalidraw files in arch/ (paths relative to arch/). */
  diagrams: string[];
}

export interface ViewState {
  parallelflowUrl: string;
  signedIn: boolean;
  user?: { displayName: string; email: string };
  signIn?: { userCode: string; uri: string };
  folder?: string;
  arena?: { id: string; name: string; key: string; stage: string | null; cycle: number | null };
  /** The linked arena's GitHub repository (owner/name), when it has one. */
  githubRepo?: string;
  isolation: Isolation;
  agent: { status: AgentStatus; model?: string; error?: string };
  mode: AgentMode;
  architecture?: ArchitectView;
  task?: TaskView;
  history: { title: string; branch: string; pr?: number }[];
  transcript: TranscriptItem[];
  approvals: ApprovalRequest[];
}

export type HostCommand =
  | 'signIn'
  | 'signOut'
  | 'cancelSignIn'
  | 'linkArena'
  | 'unlinkArena'
  | 'cloneArenaRepo'
  | 'startBuilding'
  | 'startTask'
  | 'stopAgent'
  | 'restartAgent'
  | 'newChat'
  | 'resumeChat'
  | 'pushBranch'
  | 'openPr'
  | 'reopenInContainer'
  | 'scaffoldDevContainer'
  | 'refreshArchitecture'
  | 'switchMode'
  | 'openChatTab';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'command'; command: HostCommand }
  | { type: 'startTask'; title: string; description: string }
  /** `context`: folder-relative paths (`path` or `path:L3-L9`) the person attached as chips. */
  | { type: 'prompt'; text: string; context?: string[] }
  | {
      type: 'decision';
      id: string;
      decision: 'approve' | 'approve_session' | 'deny';
      reason?: string;
    }
  | { type: 'answer'; id: string; answer: string }
  | { type: 'openUrl'; url: string }
  | { type: 'approveGate'; gate: string }
  | { type: 'openArch'; path: string }
  /** @ picker: folder files matching the query; answered with `fileResults` of the same id. */
  | { type: 'fileSearch'; requestId: number; query: string }
  /** Code block "Insert at cursor": the host inserts it into the active editor. */
  | { type: 'insertCode'; code: string }
  /** VS Code's diff of a folder file the agent changed. */
  | { type: 'openDiff'; path: string }
  | { type: 'openFile'; path: string };

export type ToWebview =
  | { type: 'state'; state: ViewState }
  | { type: 'fileResults'; requestId: number; files: string[] }
  /** "Add selection to chat": a chip for the composer. */
  | { type: 'addContext'; chip: string }
  | { type: 'focusComposer' };
