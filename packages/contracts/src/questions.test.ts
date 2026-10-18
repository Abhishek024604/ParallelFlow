import { describe, expect, it } from 'vitest';
import {
  acceptAnswer,
  AnswerQuestionSchema,
  parseQuestion,
  splitAttachments,
} from './questions.js';

describe('parseQuestion', () => {
  it('cleans a valid question: one-line text, distinct options, allow_other default false', () => {
    expect(
      parseQuestion({
        question: ' Which  database? ',
        options: ['Postgres', ' postgres', 'SQLite', ''],
      }),
    ).toEqual({ question: 'Which database?', options: ['Postgres', 'SQLite'], allow_other: false });
  });

  it('says what is wrong', () => {
    expect(parseQuestion({ question: 'Q?', options: ['only one'] })).toHaveProperty('error');
    expect(
      parseQuestion({ question: 'Q?', options: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ).toHaveProperty('error');
    expect(parseQuestion({ question: '', options: ['a', 'b'] })).toHaveProperty('error');
    expect(parseQuestion({ question: 'Q?', options: ['a', 'x'.repeat(81)] })).toHaveProperty(
      'error',
    );
    expect(
      parseQuestion({ question: 'Q?', options: ['a', 'b'], allow_other: 'yes' }),
    ).toHaveProperty('error');
    expect(parseQuestion(null)).toHaveProperty('error');
  });
});

describe('acceptAnswer', () => {
  const q = { question: 'Q?', options: ['Postgres', 'SQLite'], allow_other: false };
  it('takes an option in any case, and free text only with allow_other', () => {
    expect(acceptAnswer(q, 'postgres')).toBe('Postgres');
    expect(acceptAnswer(q, 'MySQL')).toBeNull();
    expect(acceptAnswer({ ...q, allow_other: true }, '  MySQL ')).toBe('MySQL');
    expect(AnswerQuestionSchema.safeParse({ choice: ' ' }).success).toBe(false);
  });
});

describe('splitAttachments', () => {
  it('keeps files apart from the question and answer elements', () => {
    const file = { file_id: 'f', name: 'a.txt', mime_type: 'text/plain', size_bytes: 1 };
    const out = splitAttachments([
      file,
      { type: 'question', question: 'Q?' },
      { type: 'answer', question_id: 'm', choice: 'x' },
    ]);
    expect(out.files).toEqual([file]);
    expect(out.question?.question).toBe('Q?');
    expect(out.answer?.question_id).toBe('m');
  });
});
