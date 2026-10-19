// @saras/pi-saras: the Saras extension, skills and prompt templates for the Pi harness. Loaded by
// apps/runtime for arena (central) and private (personal) sessions, and by the VS Code extension.
//
// A host loads it with Pi's DefaultResourceLoader, every other discovery switched off:
//
//   const paths = resourcePaths(profile);
//   new DefaultResourceLoader({
//     cwd, agentDir, settingsManager,
//     noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
//     extensionFactories: [createSarasExtension({ session, turn, router })],
//     additionalSkillPaths: paths.skills,
//     additionalPromptTemplatePaths: paths.prompts,
//     systemPrompt: preamble(session),
//     appendSystemPrompt: [],
//   });
//
// and adds SARAS_TOOL_NAMES to its Pi tool allowlist. See sarasResourceLoaderOptions().

import type { SarasProfile, SarasSessionContext } from './context.js';
import { createSarasExtension, type SarasExtensionOptions } from './extension.js';
import { preamble } from './context.js';
import { resourcePaths } from './resources.js';

export * from './autonomy.js';
export * from './compaction.js';
export * from './connectors.js';
export * from './context.js';
export * from './extension.js';
export * from './guardrails.js';
export * from './questions.js';
export * from './resources.js';
export * from './router.js';

/**
 * The DefaultResourceLoader options for one Saras session (spread in cwd, agentDir and
 * settingsManager). Only this package's extension, skills and templates load.
 */
export function sarasResourceLoaderOptions(options: SarasExtensionOptions) {
  const profile: SarasProfile = options.session.profile;
  const paths = resourcePaths(profile);
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createSarasExtension(options)],
    additionalSkillPaths: paths.skills,
    additionalPromptTemplatePaths: paths.prompts,
    systemPrompt: preamble(options.session satisfies SarasSessionContext),
    appendSystemPrompt: [] as string[],
  };
}
