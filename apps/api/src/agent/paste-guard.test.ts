import { describe, expect, it } from 'vitest';
import { createdLine, guardReply, repeatsContent } from './paste-guard.js';

const doc = [
  '# Launch plan',
  '',
  'We ship the beta to ten design partners in the first week of November.',
  'Each partner gets a private arena seeded with their own goal document.',
  'Feedback is collected in a shared arena and triaged every Friday by the team.',
  'The public launch follows once the onboarding flow converts above forty percent.',
].join('\n');

const draft = { artifactId: 'a-1', name: 'plan.md', versionNo: 1, content: doc };

describe('paste guard', () => {
  it('keeps a short reply that only mentions the draft', () => {
    const reply = 'Created plan.md (draft v1) — the launch plan. Have a look.';
    expect(repeatsContent(reply, doc)).toBe(false);
    expect(guardReply(reply, [draft])).toBe(reply);
  });

  it('replaces a reply that pastes the draft with the Created line', () => {
    const reply = `Here is the plan I saved:\n\n${doc}\n\nLet me know!`;
    expect(repeatsContent(reply, doc)).toBe(true);
    expect(guardReply(reply, [draft])).toBe('Created plan.md (draft v1) — Launch plan');
  });

  it('says Updated for a new version and leaves replies alone without drafts', () => {
    expect(createdLine({ ...draft, versionNo: 3 })).toBe(
      'Updated plan.md (draft v3) — Launch plan',
    );
    expect(guardReply(doc, [])).toBe(doc);
  });
});
