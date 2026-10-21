// saras-agent: the Saras Pi extension (@saras/pi-saras) for the VS Code coding agent, loaded next to
// saras-guard (`pi -ne -e builtin:mcp -e saras-guard.mjs -e saras-agent.mjs`). It brings what the
// arena's AI has: the coder profile's working rules and skills (load_skill), Saras compaction, and
// the `saras/auto` model router over the Saras LLM proxy's fast and strong tiers. The guard keeps
// the folder fence, approvals, the model provider and its own ask_user (the sidebar's protocol).
// In Architect mode it also loads SWA (@saras/pi-swa): arch/ in this folder, the /swa command and
// the swa_* tools; its files are copied to dist/swa.
// Pi resolves `@earendil-works/*` and `typebox` itself (esbuild keeps them external); the skills and
// prompt templates are copied next to this bundle (dist/skills, dist/prompts).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { compact, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSarasExtension } from '@saras/pi-saras';
import { createSwaExtension, swaResources } from '@saras/pi-swa';
import { parseAgentConfig, SARAS_PROVIDER } from '../shared/agent-config.js';

export default async function sarasAgent(pi: ExtensionAPI): Promise<void> {
  const config = parseAgentConfig(process.env.SARAS_AGENT_CONFIG);
  delete process.env.SARAS_AGENT_CONFIG;
  await createSarasExtension({
    session: {
      profile: 'coder',
      agentName: config.agentName,
      ...(config.arenaBrief && { arenaBrief: config.arenaBrief }),
    },
    ...(config.router && { router: { provider: SARAS_PROVIDER, ...config.router } }),
    askUser: false,
    cleanOutput: false,
    // Static imports: Pi's loader maps them to its own modules (dynamic import() is not mapped).
    typebox: Type,
    compact,
  })(pi);
  if (config.mode === 'architect') {
    await createSwaExtension({
      resources: swaResources(join(dirname(fileURLToPath(import.meta.url)), '..', 'swa')),
      typebox: Type,
    })(pi);
  }
}
