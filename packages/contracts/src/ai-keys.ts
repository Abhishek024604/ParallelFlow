import { z } from 'zod';

// Bring your own AI key (ADR-043). A person's key answers in their private chats; an arena owner's
// key answers for the arena's AI. Without one, ParallelFlow's own AI is used. The key itself never
// leaves the API after it is saved: the web only ever sees the provider, the model and its last 4.

/** Providers a key can be for: Pi's own provider ids (the runtime calls them natively). */
export const AI_PROVIDERS = [
  'openai',
  'anthropic',
  'deepseek',
  'openrouter',
  'google',
  'groq',
  'mistral',
  'xai',
  'together',
  'fireworks',
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const isAiProvider = (value: string): value is AiProvider =>
  (AI_PROVIDERS as readonly string[]).includes(value);

/** What people see for each provider. */
export const AI_PROVIDER_NAMES: Readonly<Record<AiProvider, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  google: 'Google Gemini',
  groq: 'Groq',
  mistral: 'Mistral',
  xai: 'xAI (Grok)',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
};

/** GET /ai-providers: each provider and the models the AI can use with it. */
export interface AiProviderList {
  items: { id: AiProvider; name: string; models: { id: string; name: string }[] }[];
}

/** A saved key as the web sees it (GET/PUT /me/ai-key, /projects/{p}/ai-key). Never the key. */
export interface AiKeyStatus {
  /** null: no key saved, ParallelFlow's AI answers. */
  key: {
    provider: AiProvider;
    model: string;
    last4: string;
    updated_at: string;
  } | null;
  /** May the caller change it (always for your own key; the owner only for an arena's). */
  can_edit: boolean;
}

/** PUT body: the provider, its key and the model to use. */
export const SaveAiKeySchema = z
  .object({
    provider: z.enum(AI_PROVIDERS, { message: 'Choose a provider' }),
    api_key: z
      .string()
      .trim()
      .min(8, 'Paste your API key')
      .max(500, 'That does not look like an API key')
      .regex(/^[\x21-\x7e]+$/, 'That does not look like an API key'),
    model: z
      .string()
      .trim()
      .min(1, 'Choose a model')
      .max(200, 'That model id is too long')
      .regex(/^[A-Za-z0-9._:/@-]+$/, 'That does not look like a model id'),
  })
  .strict();
export type SaveAiKey = z.infer<typeof SaveAiKeySchema>;
