import { describe, expect, it } from 'vitest';
import { sanitizeAiText, StreamSanitizer } from './output-filter.js';

const ID = '0190f0aa-1234-7abc-8def-0123456789ab';

describe('sanitizeAiText', () => {
  it('drops "(ID: …)" parentheticals and bare ids, keeping the sentence natural', () => {
    expect(sanitizeAiText(`Asha pushed plan.md (ID: ${ID}) yesterday.`)).toBe(
      'Asha pushed plan.md yesterday.',
    );
    expect(sanitizeAiText(`The file ID is ${ID}.`)).toBe('The file.');
    expect(sanitizeAiText(`See \`${ID}\` for details`)).toBe('See for details');
    expect(sanitizeAiText(`artifact_id: ${ID}, version 2`)).toBe('version 2');
  });

  it('hides tokens and keys', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(sanitizeAiText(`token ${jwt}`)).toBe('token [hidden]');
    expect(sanitizeAiText('Authorization: Bearer abcdef0123456789abcdef')).toBe(
      'Authorization: Bearer [hidden]',
    );
    expect(sanitizeAiText('use sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('use [hidden]');
    expect(sanitizeAiText('api_key = "s3cr3t-value-123"')).toBe('api_key = [hidden]');
  });

  it('replaces tool and internal field names', () => {
    expect(sanitizeAiText('I called `artifacts_read` and knowledge.search to check.')).toBe(
      'I called my tools and my tools to check.',
    );
    expect(sanitizeAiText('Its approved_version_no is 2.')).toBe('Its approved version is 2.');
    // Ordinary words and file names stay.
    expect(sanitizeAiText('Read project.md and the created_at column.')).toBe(
      'Read project.md and the created_at column.',
    );
  });
});

describe('StreamSanitizer', () => {
  it('filters ids split across deltas', () => {
    const s = new StreamSanitizer();
    const chunks = [
      'Asha pushed plan.md (I',
      'D: 0190f0aa-1234-7abc',
      '-8def-0123456789ab) on ',
      'Friday.',
    ];
    const out = chunks.map((c) => s.push(c)).join('') + s.flush();
    expect(out).not.toContain('0190f0aa');
    expect(out.replace(/\s+/g, ' ')).toBe('Asha pushed plan.md on Friday.');
  });
});
