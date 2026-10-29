import { describe, expect, it } from 'vitest';
import { vscodeStartLink } from './code.js';

describe('vscodeStartLink', () => {
  it('opens the packaged extension with the arena, the code and the web origin', () => {
    // apps/vscode start-link.test.ts reads exactly this shape: keep the two in step.
    expect(
      vscodeStartLink({
        arenaId: '0190f5a2-1c2d-7e3f-8a9b-0c1d2e3f4a5b',
        code: 'Abc_def-1234567890123456',
        web: 'https://app.example.com',
      }),
    ).toBe(
      'vscode://parallelflow.parallelflow-vscode/start?arena=0190f5a2-1c2d-7e3f-8a9b-0c1d2e3f4a5b&code=Abc_def-1234567890123456&web=https%3A%2F%2Fapp.example.com',
    );
  });
});
