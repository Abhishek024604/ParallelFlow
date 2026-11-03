import { describe, expect, it } from 'vitest';
import { jsonOf, parseExtraction, similarity, slug } from './model.js';
import { parseNarration } from './prompts.js';

describe('extraction schema', () => {
  const valid = {
    nodes: [
      {
        ref: 'n1',
        type: 'Decision',
        key: null,
        title: 'Use Postgres for the event store',
        refs: ['M3'],
        confidence: 0.9,
      },
      { ref: 'n2', type: 'Person', title: 'Asha', roles: ['Owner'], refs: ['M3'] },
    ],
    edges: [{ from: 'n1', to: 'n2', type: 'DECIDED_BY', refs: ['M3'] }],
  };

  it('accepts a reply in a json fence and fills the defaults', () => {
    const parsed = parseExtraction(`Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.nodes[1]).toMatchObject({ summary: '', status: null, confidence: 0.8 });
    expect(parsed.value.supersedes).toEqual([]);
    expect(parsed.value.status_changes).toEqual([]);
  });

  it('refuses unknown types, extra fields and invented refs, naming the field only', () => {
    const bad = {
      nodes: [{ ref: 'n1', type: 'Secret', title: 'x', refs: ['M3'] }],
      edges: [{ from: 'n1', to: 'n2', type: 'LIKES' }],
    };
    const parsed = parseExtraction(JSON.stringify(bad));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/nodes\.0\.type/);
    expect(parsed.error).not.toContain('Secret');

    const extra = parseExtraction(JSON.stringify({ ...valid, comment: 'hi' }));
    expect(extra.ok).toBe(false);
    const ref = parseExtraction(
      JSON.stringify({ nodes: [{ ref: 'n1', type: 'Risk', title: 'x', refs: ['msg-12'] }] }),
    );
    expect(ref.ok).toBe(false);
  });

  it('says when there is no JSON at all', () => {
    expect(parseExtraction('Sorry, I cannot.')).toEqual({
      ok: false,
      error: 'the reply has no JSON object',
    });
    expect(parseExtraction('{ not json }')).toMatchObject({ ok: false });
    expect(jsonOf('text {"a": 1} more')).toBe('{"a": 1}');
  });

  it('slugs and compares titles', () => {
    expect(slug('Checkout Service!')).toBe('checkout-service');
    expect(similarity('Use Postgres for the event store', 'use postgres event store')).toBe(1);
    expect(similarity('Use Postgres', 'Ship on Friday')).toBe(0);
  });
});

describe('narration reply', () => {
  it('reads the title, chapter and story', () => {
    const n = parseNarration(
      '**TITLE:** The data model settles\nCHAPTER:\nAsha chose Postgres [D-004].\n\nRavi agreed.\nSTORY:\nThe team is building TrackFlow.',
    );
    expect(n).toEqual({
      title: 'The data model settles',
      chapter: 'Asha chose Postgres [D-004].\n\nRavi agreed.',
      story: 'The team is building TrackFlow.',
    });
  });

  it('refuses a reply without the parts', () => {
    expect(parseNarration('TITLE: x\nSTORY:\ny')).toBeNull();
    expect(parseNarration('Just a summary.')).toBeNull();
  });
});
