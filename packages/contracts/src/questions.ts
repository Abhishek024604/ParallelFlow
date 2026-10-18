import { z } from 'zod';

// AI questions (ask.question): when a request is ambiguous, the AI asks the person who asked it a
// multiple-choice question instead of guessing. App Tools validates the call, the runtime delivers
// it as the RIC event `question.asked`, and the API stores it on the AI's message (a typed element
// in `messages.attachments`, no schema change). Only the person who asked the AI answers; their
// answer is posted as their message and starts the AI's next turn.

export const QUESTION_MAX_CHARS = 300;
export const QUESTION_OPTION_MAX_CHARS = 80;
export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 5;
/** An "Other" answer typed by the person. */
export const QUESTION_ANSWER_MAX_CHARS = 300;

/** What the AI asks (the ask.question arguments, cleaned). */
export interface QuestionAsk {
  question: string;
  options: string[];
  allow_other: boolean;
}

/** A question card on an AI message. */
export interface AiQuestion extends QuestionAsk {
  /** The only person who can answer: whoever asked the AI. */
  asked_of: { id: string; display_name: string };
  answer: { choice: string; message_id: string; at: string } | null;
}

/** The stored element in `messages.attachments` (never shown as a file). */
export interface StoredQuestion extends QuestionAsk {
  type: 'question';
  asked_of: string;
  asked_of_name: string;
  answer: AiQuestion['answer'];
}

/** The marker on the answer message: which question it answers. */
export interface StoredAnswer {
  type: 'answer';
  question_id: string;
  choice: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The AI's ask.question arguments, validated and cleaned: a question (≤ 300 characters), 2–5
 * distinct short options (≤ 80 characters each) and whether "Other" is allowed. An error says what
 * to fix (the model sees it).
 */
export function parseQuestion(input: unknown): QuestionAsk | { error: string } {
  if (!input || typeof input !== 'object') return { error: 'args must be an object' };
  const raw = input as Record<string, unknown>;
  const question = typeof raw['question'] === 'string' ? oneLine(raw['question']) : '';
  if (!question) return { error: 'question is required' };
  if (question.length > QUESTION_MAX_CHARS) {
    return { error: `question must be at most ${QUESTION_MAX_CHARS} characters` };
  }
  if (!Array.isArray(raw['options'])) return { error: 'options must be a list of short strings' };
  const options: string[] = [];
  for (const option of raw['options']) {
    if (typeof option !== 'string') return { error: 'options must be strings' };
    const clean = oneLine(option);
    if (!clean) continue;
    if (clean.length > QUESTION_OPTION_MAX_CHARS) {
      return { error: `each option must be at most ${QUESTION_OPTION_MAX_CHARS} characters` };
    }
    if (!options.some((o) => o.toLowerCase() === clean.toLowerCase())) options.push(clean);
  }
  if (options.length < QUESTION_OPTIONS_MIN || options.length > QUESTION_OPTIONS_MAX) {
    return {
      error: `give ${QUESTION_OPTIONS_MIN} to ${QUESTION_OPTIONS_MAX} different options`,
    };
  }
  const allowOther = raw['allow_other'];
  if (allowOther !== undefined && typeof allowOther !== 'boolean') {
    return { error: 'allow_other must be true or false' };
  }
  return { question, options, allow_other: allowOther === true };
}

/**
 * The chosen answer, if it fits the question: one of the options (any case, returned as written in
 * the option), or any short text when "Other" is allowed. Null when it does not fit.
 */
export function acceptAnswer(question: QuestionAsk, choice: string): string | null {
  const clean = oneLine(choice);
  if (!clean) return null;
  const option = question.options.find((o) => o.toLowerCase() === clean.toLowerCase());
  if (option) return option;
  return question.allow_other && clean.length <= QUESTION_ANSWER_MAX_CHARS ? clean : null;
}

/** The answer message's text: "<question> → <choice>". */
export function answerBody(question: string, choice: string): string {
  return `${question} → ${choice}`;
}

/** What the AI receives as the person's next message. */
export function answerTurnText(question: string, choice: string): string {
  return `My answer to your question "${question}": ${choice}`;
}

/** Splits a stored attachments array into files, a question card and an answer marker. */
export function splitAttachments<F>(stored: readonly unknown[] | null): {
  files: F[];
  question: StoredQuestion | null;
  answer: StoredAnswer | null;
} {
  const files: F[] = [];
  let question: StoredQuestion | null = null;
  let answer: StoredAnswer | null = null;
  for (const item of stored ?? []) {
    const type = item && typeof item === 'object' ? (item as { type?: unknown }).type : undefined;
    if (type === 'question') question = item as StoredQuestion;
    else if (type === 'answer') answer = item as StoredAnswer;
    else files.push(item as F);
  }
  return { files, question, answer };
}

/** The card a viewer sees for a stored question. */
export function questionCard(stored: StoredQuestion): AiQuestion {
  return {
    question: stored.question,
    options: stored.options,
    allow_other: stored.allow_other,
    asked_of: { id: stored.asked_of, display_name: stored.asked_of_name },
    answer: stored.answer ?? null,
  };
}

/** POST …/messages/{message_id}/answer body. */
export const AnswerQuestionSchema = z
  .object({
    choice: z
      .string()
      .trim()
      .min(1, 'Pick an answer')
      .max(QUESTION_ANSWER_MAX_CHARS, `At most ${QUESTION_ANSWER_MAX_CHARS} characters`),
  })
  .strict();
export type AnswerQuestion = z.output<typeof AnswerQuestionSchema>;
