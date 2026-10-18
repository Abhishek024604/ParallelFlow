// Turns Pi extension UI requests (from saras-guard or Pi itself) into approval cards and sends the
// person's answer back. Anything unanswered is denied.
import type { UiRequest, UiResponse } from '../pi/rpc.js';
import { decodeRequest, encodeAnswer } from '../shared/protocol.js';
import type { ApprovalBroker } from './broker.js';

export interface UiBridgeDeps {
  broker: ApprovalBroker;
  /** Default and maximum time to wait for the person. */
  timeoutMs: number;
  respond(id: string, response: UiResponse): void;
  notify(level: 'info' | 'warning' | 'error', message: string): void;
}

export async function handleUiRequest(req: UiRequest, deps: UiBridgeDeps): Promise<void> {
  const timeoutMs = Math.max(
    1000,
    Math.min(deps.timeoutMs, typeof req.timeout === 'number' ? req.timeout - 1000 : deps.timeoutMs),
  );
  switch (req.method) {
    case 'notify':
      deps.notify(req.notifyType ?? 'info', String(req.message ?? ''));
      return;
    case 'select': {
      const tagged = decodeRequest(String(req.title ?? ''));
      if (tagged?.kind === 'command' || tagged?.kind === 'edit') {
        const answer = await deps.broker.request(
          tagged.kind === 'command'
            ? {
                id: req.id,
                kind: 'command',
                title: 'Run this command?',
                detail: tagged.command,
                cwd: tagged.cwd,
                reason: tagged.reason,
              }
            : {
                id: req.id,
                kind: 'edit',
                title: `Allow this ${tagged.tool}?`,
                detail: tagged.path,
                reason: tagged.reason,
              },
          timeoutMs,
        );
        if ('decision' in answer) deps.respond(req.id, { value: encodeAnswer(answer) });
        else deps.respond(req.id, { cancelled: true });
        return;
      }
      const question = tagged?.kind === 'question' ? tagged.question : String(req.title ?? '');
      const options = tagged?.kind === 'question' ? tagged.options : (req.options ?? []);
      const answer = await deps.broker.request(
        { id: req.id, kind: 'question', title: 'The agent asks', detail: question, options },
        timeoutMs,
      );
      if ('answer' in answer) {
        deps.respond(req.id, { value: tagged ? encodeAnswer(answer) : answer.answer });
      } else {
        deps.respond(req.id, { cancelled: true });
      }
      return;
    }
    case 'confirm': {
      const answer = await deps.broker.request(
        {
          id: req.id,
          kind: 'confirm',
          title: String(req.title ?? 'Confirm'),
          detail: String(req.message ?? ''),
        },
        timeoutMs,
      );
      deps.respond(req.id, {
        confirmed: 'decision' in answer && answer.decision !== 'deny',
      });
      return;
    }
    case 'input':
    case 'editor': {
      const answer = await deps.broker.request(
        {
          id: req.id,
          kind: 'question',
          title: 'The agent asks',
          detail: String(req.title ?? ''),
          options: [],
        },
        timeoutMs,
      );
      if ('answer' in answer) deps.respond(req.id, { value: answer.answer });
      else deps.respond(req.id, { cancelled: true });
      return;
    }
    default:
      // setStatus, setWidget, setTitle, set_editor_text: nothing to show in VS Code.
      return;
  }
}
