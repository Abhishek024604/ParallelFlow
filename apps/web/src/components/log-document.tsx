'use client';

import { MarkdownView } from './markdown';

// PROGRESS.md and STATE.md in the viewer: each "## " section is its own card, tinted by what it
// holds, so the parts read apart at a glance (brand tokens only):
//
//   overview (title, now, at a glance) · neutral      Key decisions · sage (positive)
//   Stages · ink edge (where the cycle is)             Open questions · amber (waiting on someone)
//   Timeline, Log · raised neutral (the record)        Day by day · dusk (written by the AI)
//
// The files themselves stay plain Markdown (the repo copy reads the same).

type Tone = 'plain' | 'stage' | 'record' | 'decision' | 'question' | 'ai';

const TONE_BY_TITLE: Record<string, Tone> = {
  Stages: 'stage',
  Timeline: 'record',
  Log: 'record',
  'Key decisions': 'decision',
  'Open questions': 'question',
  'Day by day': 'ai',
};

const TONE_CLASS: Record<Tone, { card: string; title: string }> = {
  plain: { card: 'border-line bg-panel', title: 'text-text' },
  stage: { card: 'border-line bg-panel border-l-4 border-l-ink', title: 'text-text' },
  record: { card: 'border-line bg-raise', title: 'text-muted' },
  decision: { card: 'border-ok-line bg-ok-soft', title: 'text-ok' },
  question: { card: 'border-warn-line bg-warn-soft', title: 'text-warn' },
  ai: { card: 'border-ai-line bg-ai-soft', title: 'text-ai-ink' },
};

interface Section {
  title: string | null;
  body: string;
}

/** The document split at its "## " headings (the part before the first is the overview). */
export function splitSections(text: string): Section[] {
  const parts = text.split(/^## (.+)$/m);
  const sections: Section[] = [{ title: null, body: parts[0] ?? '' }];
  for (let i = 1; i < parts.length; i += 2) {
    sections.push({ title: (parts[i] ?? '').trim(), body: parts[i + 1] ?? '' });
  }
  return sections.filter((s) => s.title !== null || s.body.trim());
}

export const isLogKind = (kind: string): boolean => kind === 'progress' || kind === 'stage_summary';

export function LogDocument({ text }: { text: string }) {
  return (
    <div className="space-y-4">
      {splitSections(text).map((section, i) => {
        const tone =
          TONE_CLASS[section.title ? (TONE_BY_TITLE[section.title] ?? 'plain') : 'plain'];
        return (
          <section
            key={`${section.title ?? 'overview'}-${i}`}
            aria-label={section.title ?? 'Overview'}
            className={`rounded-[10px] border px-5 py-4 ${tone.card}`}
          >
            {section.title && (
              <h2
                className={`mb-3 text-[12px] font-semibold uppercase tracking-[0.07em] ${tone.title}`}
              >
                {section.title}
              </h2>
            )}
            <MarkdownView text={section.body.trim()} />
          </section>
        );
      })}
    </div>
  );
}
