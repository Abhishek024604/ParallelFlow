import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent';

// Questions, Pi-native: the model calls `ask_user`, which asks through `ctx.ui.select` (with an
// "Other" option answered through `ctx.ui.input`). A host with a live UI (a terminal, VS Code) answers
// at once and the turn goes on. The ParallelFlow runtime's UI bridge (createQuestionBridge) instead turns the
// select into the RIC `question.asked` event and answers "no answer yet": the tool then ends the turn
// (terminate) and the person's answer arrives as their next message (the app's answer flow).

export const ASK_USER = 'ask_user';
/** The extra option for a typed answer. */
export const OTHER_OPTION = 'Other…';

export const QUESTION_MAX_CHARS = 300;
export const OPTION_MAX_CHARS = 80;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;

/** RIC QuestionAsked. */
export interface AskedQuestion {
  question: string;
  options: string[];
  allow_other: boolean;
}

/** The arguments cleaned, or an error the model reads. */
export function parseAsk(args: unknown): AskedQuestion | { error: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  const question = typeof a['question'] === 'string' ? a['question'].trim() : '';
  if (!question) return { error: 'question is required' };
  if (question.length > QUESTION_MAX_CHARS) {
    return { error: `question must be at most ${QUESTION_MAX_CHARS} characters` };
  }
  const raw = Array.isArray(a['options']) ? a['options'] : [];
  const options = [
    ...new Set(
      raw
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  ];
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return { error: `give ${MIN_OPTIONS} to ${MAX_OPTIONS} distinct options` };
  }
  if (options.some((o) => o.length > OPTION_MAX_CHARS)) {
    return { error: `each option must be at most ${OPTION_MAX_CHARS} characters` };
  }
  return { question, options, allow_other: a['allow_other'] === true };
}

export const ASK_USER_DESCRIPTION =
  'Ask the person who wrote the message a multiple-choice question, when their request is ambiguous or a choice would materially change the result. Give 2-5 short, distinct options; set allow_other to let them type their own answer. Do not ask what you can find out with your other tools. If they cannot answer right away, stop and wait: their answer arrives as their next message.';

export const ASK_USER_PARAMETERS = {
  type: 'object',
  properties: {
    question: { type: 'string', maxLength: QUESTION_MAX_CHARS },
    options: {
      type: 'array',
      minItems: MIN_OPTIONS,
      maxItems: MAX_OPTIONS,
      items: { type: 'string', maxLength: OPTION_MAX_CHARS },
    },
    allow_other: { type: 'boolean' },
  },
  required: ['question', 'options'],
  additionalProperties: false,
} as const;

export const WAIT_TEXT =
  'The question is shown to them with these options. Stop now and wait for their answer; do not answer it yourself or continue the task.';

type Ui = Pick<ExtensionUIContext, 'select' | 'input'>;

export interface AskOutcome {
  /** What the model reads. */
  text: string;
  /** True when no answer is available yet: the turn ends here. */
  waiting: boolean;
}

/** Asks through the UI and returns what the model reads. */
export async function askThroughUi(
  ui: Ui,
  ask: AskedQuestion,
  signal?: AbortSignal,
): Promise<AskOutcome> {
  const options = ask.allow_other ? [...ask.options, OTHER_OPTION] : ask.options;
  const choice = await ui.select(ask.question, options, signal ? { signal } : undefined);
  if (choice === undefined) return { text: WAIT_TEXT, waiting: true };
  if (choice === OTHER_OPTION) {
    const typed = (await ui.input(ask.question, 'Type your answer'))?.trim();
    if (!typed) return { text: WAIT_TEXT, waiting: true };
    return { text: `They answered: ${typed}`, waiting: false };
  }
  return { text: `They chose: ${choice}`, waiting: false };
}

const noop = () => undefined;

/**
 * A UI context for hosts without an interactive person (the ParallelFlow runtime): `select` hands the
 * question to `onQuestion` and answers "not yet"; every other dialog answers "not yet" too, and
 * display calls do nothing. One bridge per session.
 */
export function createQuestionBridge(
  onQuestion: (question: AskedQuestion) => void,
): ExtensionUIContext {
  const bridge = {
    select: async (title: string, options: string[]) => {
      const other = options.includes(OTHER_OPTION);
      onQuestion({
        question: title,
        options: options.filter((o) => o !== OTHER_OPTION),
        allow_other: other,
      });
      return undefined;
    },
    confirm: async () => false,
    input: async () => undefined,
    editor: async () => undefined,
    custom: async () => undefined,
    notify: noop,
    onTerminalInput: () => noop,
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
    setHeader: noop,
    setTitle: noop,
    pasteToEditor: noop,
    setEditorText: noop,
    getEditorText: () => '',
    addAutocompleteProvider: noop,
    setEditorComponent: noop,
    getEditorComponent: () => undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: 'UI not available' }),
    getToolsExpanded: () => false,
    setToolsExpanded: noop,
  };
  return bridge as unknown as ExtensionUIContext;
}
