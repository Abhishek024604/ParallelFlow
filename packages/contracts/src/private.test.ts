import { describe, expect, it } from 'vitest';
import {
  CHAT_LIST_DEFAULT,
  CHAT_TITLE_MAX_CHARS,
  CreatePrivateChatSchema,
  ListPrivateChatsQuerySchema,
  MovePrivateChatSchema,
  PrivateProjectNameSchema,
  RenamePrivateChatSchema,
  titleFromMessage,
} from './private.js';

const ID = '0192F0A0-0000-7000-8000-00000000A001';

describe('CreatePrivateChatSchema', () => {
  it('accepts an empty body, a trimmed title and a lower-cased project id', () => {
    expect(CreatePrivateChatSchema.parse({})).toEqual({});
    expect(CreatePrivateChatSchema.parse({ title: '  Plan  ', private_project_id: ID })).toEqual({
      title: 'Plan',
      private_project_id: ID.toLowerCase(),
    });
  });

  it.each([
    ['blank title', { title: '   ' }],
    ['long title', { title: 'a'.repeat(CHAT_TITLE_MAX_CHARS + 1) }],
    ['bad project id', { private_project_id: 'nope' }],
    ['binding (later)', { bind_project_id: ID }],
  ])('rejects %s', (_name, input) => {
    expect(CreatePrivateChatSchema.safeParse(input).success).toBe(false);
  });
});

describe('RenamePrivateChatSchema / PrivateProjectNameSchema', () => {
  it('needs a non-blank name', () => {
    expect(RenamePrivateChatSchema.parse({ title: ' x ' })).toEqual({ title: 'x' });
    expect(RenamePrivateChatSchema.safeParse({}).success).toBe(false);
    expect(PrivateProjectNameSchema.parse({ name: ' Ideas ' })).toEqual({ name: 'Ideas' });
    expect(PrivateProjectNameSchema.safeParse({ name: '' }).success).toBe(false);
    expect(PrivateProjectNameSchema.safeParse({ name: 'a'.repeat(81) }).success).toBe(false);
  });
});

describe('MovePrivateChatSchema', () => {
  it('takes a project id or null', () => {
    expect(MovePrivateChatSchema.parse({ private_project_id: null })).toEqual({
      private_project_id: null,
    });
    expect(MovePrivateChatSchema.parse({ private_project_id: ID }).private_project_id).toBe(
      ID.toLowerCase(),
    );
    expect(MovePrivateChatSchema.safeParse({}).success).toBe(false);
  });
});

describe('ListPrivateChatsQuerySchema', () => {
  it('defaults the limit and trims q', () => {
    expect(ListPrivateChatsQuerySchema.parse({ q: ' plan ' })).toEqual({
      limit: CHAT_LIST_DEFAULT,
      q: 'plan',
    });
    expect(ListPrivateChatsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });
});

describe('titleFromMessage', () => {
  it('uses the first line', () => {
    expect(titleFromMessage('  Draft the plan\nwith details')).toBe('Draft the plan');
  });

  it('cuts long lines at a word', () => {
    const title = titleFromMessage(`${'word '.repeat(20)}end`);
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith('…')).toBe(true);
  });

  it('never returns an empty title', () => {
    expect(titleFromMessage('\n\nhello')).toBe('hello');
    expect(titleFromMessage('   ')).toBe('New chat');
  });
});
