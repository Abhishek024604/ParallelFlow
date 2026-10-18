// Messages between the extension host and the sidebar webview.
import type { ApprovalRequest } from '../approvals/broker.js';
import type { TranscriptItem } from '../pi/transcript.js';

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
}

export interface ViewState {
  sarasUrl: string;
  signedIn: boolean;
  user?: { displayName: string; email: string };
  signIn?: { userCode: string; uri: string };
  folder?: string;
  arena?: { id: string; name: string; key: string; stage: string | null; cycle: number | null };
  isolation: Isolation;
  agent: { status: AgentStatus; model?: string; error?: string };
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
  | 'cloneArenaRepo'
  | 'stopAgent'
  | 'restartAgent'
  | 'pushBranch'
  | 'openPr'
  | 'reopenInContainer'
  | 'scaffoldDevContainer'
  | 'refreshArchitecture';

export type FromWebview =
  | { type: 'ready' }
  | { type: 'command'; command: HostCommand }
  | { type: 'startTask'; title: string; description: string }
  | { type: 'prompt'; text: string }
  | {
      type: 'decision';
      id: string;
      decision: 'approve' | 'approve_session' | 'deny';
      reason?: string;
    }
  | { type: 'answer'; id: string; answer: string }
  | { type: 'openUrl'; url: string };

export type ToWebview = { type: 'state'; state: ViewState };
