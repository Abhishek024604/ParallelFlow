// @parallelflow/pi-parallelflow: the ParallelFlow extension, skills and prompt templates for the Pi harness. Loaded by
// apps/runtime for arena (central) and private (personal) sessions, and by the VS Code extension.
//
// A host loads it with Pi's DefaultResourceLoader, every other discovery switched off:
//
//   const paths = resourcePaths(profile, options.session.extensions);
//   new DefaultResourceLoader({
//     cwd, agentDir, settingsManager,
//     noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
//     extensionFactories: [createParallelFlowExtension({ session, turn, router })],
//     additionalSkillPaths: paths.skills,
//     additionalPromptTemplatePaths: paths.prompts,
//     systemPrompt: preamble(session),
//     appendSystemPrompt: [],
//   });
//
// and adds PARALLELFLOW_TOOL_NAMES to its Pi tool allowlist. See parallelflowResourceLoaderOptions().

import type { ParallelFlowProfile, ParallelFlowSessionContext } from './context.js';
import { createParallelFlowExtension, type ParallelFlowExtensionOptions } from './extension.js';
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
 * The DefaultResourceLoader options for one ParallelFlow session (spread in cwd, agentDir and
 * settingsManager). Only this package's extension, skills and templates load.
 */
export function parallelflowResourceLoaderOptions(options: ParallelFlowExtensionOptions) {
  const profile: ParallelFlowProfile = options.session.profile;
  const paths = resourcePaths(profile);
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [createParallelFlowExtension(options)],
    additionalSkillPaths: paths.skills,
    additionalPromptTemplatePaths: paths.prompts,
    systemPrompt: preamble(options.session satisfies ParallelFlowSessionContext),
    appendSystemPrompt: [] as string[],
  };
}
