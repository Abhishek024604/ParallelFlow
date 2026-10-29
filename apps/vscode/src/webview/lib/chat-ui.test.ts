import { describe, expect, it } from 'vitest';
import type { TranscriptItem } from '../../pi/transcript.js';
import { cleanChips, contextLine, selectionChip } from '../../shared/context-chips.js';
import { changedFiles, countDiff, countLines, totalStats } from '../../shared/diff-stats.js';
import { rankFiles } from '../../shared/file-rank.js';
import {
  approvalKey,
  composerKey,
  isTypingTarget,
  menuKey,
  moveIndex,
  questionKey,
} from './keys.js';
import { safeHref } from './links.js';
import { renderMarkdown } from './markdown.js';
import { filterSlash, mentionAt, removeMention, slashQuery } from './menus.js';
import { exploreLabel, groupStatus, toRows, type ToolItem } from './tool-groups.js';

const tool = (
  id: string,
  name: string,
  summary: string,
  extra: Partial<ToolItem> = {},
): ToolItem => ({
  kind: 'tool',
  id,
  tool: name,
  summary,
  status: 'ok',
  ...extra,
});

describe('chat markdown and links', () => {
  it('allows only http and https links', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,hi')).toBeUndefined();
    expect(safeHref('vscode://x')).toBeUndefined();
    expect(safeHref('not a url')).toBeUndefined();
  });

  it('escapes HTML and drops unsafe links and images', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script> [bad](javascript:alert(1)) [ok](https://a.example) ![i](https://a.example/x.png)',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('href="https://a.example"');
    expect(html).not.toContain('<img');
  });

  it('renders code blocks, tables and linkified URLs', () => {
    const html = renderMarkdown(
      '# T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1 < 2;\n```\n\nsee https://x.example',
    );
    expect(html).toContain('<h1>T</h1>');
    expect(html).toContain('<table>');
    expect(html).toContain('<code class="language-ts">const x = 1 &lt; 2;');
    expect(html).toContain('href="https://x.example"');
  });
});

describe('tool rows', () => {
  it('groups consecutive read/ls/find/grep calls and keeps the first id as key', () => {
    const items: TranscriptItem[] = [
      tool('t1', 'read', 'a.ts'),
      tool('t2', 'read', 'b.ts'),
      tool('t3', 'grep', 'foo'),
      { kind: 'assistant', id: 'a1', text: 'hi', thinking: '', streaming: false },
      tool('t4', 'edit', 'a.ts'),
      tool('t5', 'ls', '.'),
    ];
    const rows = toRows(items);
    expect(rows.map((r) => r.key)).toEqual(['g:t1', 'a1', 't4', 'g:t5']);
    const first = rows[0]!;
    expect(first.kind === 'explore' && exploreLabel(first.items)).toBe(
      'Read 2 files, searched 1 time',
    );
    expect(exploreLabel([tool('x', 'find', 'p'), tool('y', 'grep', 'q')])).toBe('Searched 2 times');
    expect(exploreLabel([tool('x', 'read', 'a'), tool('y', 'read', 'a')])).toBe('Read 1 file');
  });

  it('reports the status of a group', () => {
    expect(
      groupStatus([tool('a', 'read', 'x'), tool('b', 'read', 'y', { status: 'running' })]),
    ).toBe('running');
    expect(groupStatus([tool('a', 'read', 'x', { status: 'error' })])).toBe('error');
    expect(groupStatus([tool('a', 'read', 'x')])).toBe('ok');
  });
});

describe('diff counts', () => {
  it('counts Pi edit diffs and unified diffs', () => {
    expect(countDiff('+1 a\n-1 b\n 2 c\n+3 d')).toEqual({ added: 2, removed: 1 });
    expect(countDiff('--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new')).toEqual({
      added: 1,
      removed: 1,
    });
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
    expect(countLines('')).toBe(0);
  });

  it('sums changed files from successful edit and write calls', () => {
    const files = changedFiles([
      tool('1', 'edit', 'a.ts', { diff: '+1 x\n-1 y' }),
      tool('2', 'write', 'b.ts', { stats: { added: 10, removed: 0 } }),
      tool('3', 'edit', 'a.ts', { stats: { added: 3, removed: 2 } }),
      tool('4', 'edit', 'c.ts', { status: 'error', diff: '+1 z' }),
      tool('5', 'read', 'd.ts'),
    ]);
    expect(files).toEqual([
      { path: 'a.ts', added: 4, removed: 3 },
      { path: 'b.ts', added: 10, removed: 0 },
    ]);
    expect(totalStats(files)).toEqual({ added: 14, removed: 3 });
  });
});

describe('composer menus', () => {
  it('opens the slash menu only for a one-line command', () => {
    expect(slashQuery('/sw')).toBe('sw');
    expect(slashQuery('hello /sw')).toBeUndefined();
    expect(slashQuery('/swa\nmore')).toBeUndefined();
  });

  it('filters slash items, prefix matches first', () => {
    const labels = filterSlash('swa s').map((i) => i.label);
    expect(labels[0]).toBe('/swa status');
    expect(labels).toContain('/swa stack');
    expect(filterSlash('pr').map((i) => i.label)[0]).toBe('/pr');
    expect(filterSlash('zzzz')).toEqual([]);
    expect(filterSlash('').length).toBeGreaterThan(10);
  });

  it('finds the @ mention at the caret', () => {
    expect(mentionAt('look at @src/a', 14)).toEqual({ start: 8, query: 'src/a' });
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAt('mail me@x.com', 13)).toBeUndefined();
    expect(mentionAt('@a b', 4)).toBeUndefined();
    expect(removeMention('see @src/a now', { start: 4, query: 'src/a' })).toEqual({
      text: 'see  now',
      caret: 4,
    });
  });

  it('ranks files: name prefix, name, path, fuzzy', () => {
    const files = ['src/webview/main.ts', 'src/main.ts', 'docs/domain.md', 'src/m/a/i/n.txt'];
    expect(rankFiles('main', files)).toEqual([
      'src/main.ts',
      'src/webview/main.ts',
      'docs/domain.md',
      'src/m/a/i/n.txt',
    ]);
    expect(rankFiles('webview', files)).toEqual(['src/webview/main.ts']);
    expect(rankFiles('', files, 2)).toEqual(['src/main.ts', 'docs/domain.md']);
  });

  it('cleans context chips and builds the prompt line', () => {
    expect(cleanChips(['a.ts', 'a.ts', '../x', '/etc/passwd', 'C:\\x', 'b.ts:L1-L3', 5])).toEqual([
      'a.ts',
      'b.ts:L1-L3',
    ]);
    expect(contextLine(['a.ts'])).toBe('\n\nContext files: @a.ts');
    expect(contextLine([])).toBe('');
    expect(selectionChip('src\\a.ts', 3, 9)).toBe('src/a.ts:L3-L9');
    expect(selectionChip('a.ts', 3, 3)).toBe('a.ts:L3');
  });
});

describe('keyboard', () => {
  it('maps 1/2/3 on approvals', () => {
    expect(approvalKey('1', 'command')).toBe('approve');
    expect(approvalKey('2', 'command')).toBe('approve_session');
    expect(approvalKey('3', 'command')).toBe('deny');
    expect(approvalKey('2', 'edit')).toBe('deny');
    expect(approvalKey('3', 'edit')).toBeUndefined();
    expect(approvalKey('1', 'question')).toBeUndefined();
    expect(approvalKey('a', 'command')).toBeUndefined();
    expect(questionKey('2', 3)).toBe(1);
    expect(questionKey('4', 3)).toBeUndefined();
  });

  it('sends on Enter, not on Shift+Enter or while composing', () => {
    expect(composerKey({ key: 'Enter' })).toBe('send');
    expect(composerKey({ key: 'Enter', shiftKey: true })).toBe('newline');
    expect(composerKey({ key: 'Enter', isComposing: true })).toBeUndefined();
    expect(composerKey({ key: 'Enter', keyCode: 229 })).toBeUndefined();
    expect(composerKey({ key: 'a' })).toBeUndefined();
  });

  it('navigates menus and ignores typing targets', () => {
    expect(menuKey({ key: 'ArrowDown' })).toBe('down');
    expect(menuKey({ key: 'Tab' })).toBe('pick');
    expect(menuKey({ key: 'Escape' })).toBe('close');
    expect(menuKey({ key: 'Enter', isComposing: true })).toBeUndefined();
    expect(moveIndex(0, -1, 3)).toBe(2);
    expect(moveIndex(2, 1, 3)).toBe(0);
    expect(isTypingTarget('input')).toBe(true);
    expect(isTypingTarget('BUTTON')).toBe(false);
    expect(isTypingTarget('DIV', true)).toBe(true);
  });
});
