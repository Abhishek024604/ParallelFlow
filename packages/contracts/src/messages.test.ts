import { describe, expect, it } from 'vitest';
import {
  ListArenaMessagesQuerySchema,
  MESSAGE_BODY_MAX_CHARS,
  mentionsAi,
  SendArenaMessageSchema,
} from './messages.js';

describe('SendArenaMessageSchema', () => {
  it('trims the body and keeps line breaks inside it', () => {
    expect(SendArenaMessageSchema.parse({ body: '  hello\nteam  ' })).toEqual({
      body: 'hello\nteam',
    });
  });

  it('lower-cases parent_id', () => {
    const id = '0192F0A0-0000-7000-8000-00000000A001';
    expect(SendArenaMessageSchema.parse({ body: 'x', parent_id: id }).parent_id).toBe(
      id.toLowerCase(),
    );
  });

  it.each([
    ['empty', { body: '' }],
    ['only whitespace', { body: ' \n\t ' }],
    ['too many characters', { body: 'a'.repeat(MESSAGE_BODY_MAX_CHARS + 1) }],
    // 7,000 three-byte characters: under the character limit, over 20 KB.
    ['over 20 KB', { body: '€'.repeat(7_000) }],
    ['bad parent_id', { body: 'x', parent_id: 'nope' }],
    ['unknown field', { body: 'x', model_class: 'fast' }],
    ['no body', {}],
  ])('rejects %s', (_, input) => {
    expect(SendArenaMessageSchema.safeParse(input).success).toBe(false);
  });

  it('accepts the longest allowed ASCII body', () => {
    expect(
      SendArenaMessageSchema.safeParse({ body: 'a'.repeat(MESSAGE_BODY_MAX_CHARS) }).success,
    ).toBe(true);
  });
});

describe('ListArenaMessagesQuerySchema', () => {
  it('defaults limit to 50 and coerces strings', () => {
    expect(ListArenaMessagesQuerySchema.parse({}).limit).toBe(50);
    expect(ListArenaMessagesQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('rejects limits out of range and after with cursor', () => {
    expect(ListArenaMessagesQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ListArenaMessagesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListArenaMessagesQuerySchema.safeParse({ after: 'a', cursor: 'b' }).success).toBe(false);
  });
});

describe('mentionsAi', () => {
  it('matches @AI as a word in any case', () => {
    for (const yes of ['@AI help', 'hey @ai', '@Ai, what next?', '(@AI)', 'ok @AI.', 'line\n@ai']) {
      expect(mentionsAi(yes), yes).toBe(true);
    }
    for (const no of ['AI help', 'me@ai.com', '@aim', '@ai_bot', '@ai-team', 'x@AI', '@@ai']) {
      expect(mentionsAi(no), no).toBe(false);
    }
  });
});
