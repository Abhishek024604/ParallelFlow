// saras-agent: the Saras Pi extension (@saras/pi-saras) for the VS Code coding agent, loaded next to
// saras-guard (`pi -ne -e builtin:mcp -e saras-guard.mjs -e saras-agent.mjs`). It brings what the
// arena's AI has: the coder profile's working rules and skills (load_skill), Saras compaction, and
// the `saras/auto` model router over the Saras LLM proxy's fast and strong tiers (or over Claude
// models, when the person runs the agent on their own Claude subscription). The guard keeps
// the folder fence, approvals, the model provider and its own ask_user (the sidebar's protocol).
// It also loads SWA (@saras/pi-swa): arch/ in this folder, the /swa command and the swa_* tools;
// its files are copied to dist/swa.
// Pi resolves `@earendil-works/*` and `typebox` itself (esbuild keeps them external); the skills and
// prompt templates are copied next to this bundle (dist/skills, dist/prompts).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { compact, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSarasExtension } from '@saras/pi-saras';
import { type ArchStore, createSwaExtension, FsArchStore, swaResources } from '@saras/pi-swa';
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
    ...(config.router && {
      router: { provider: config.provider ?? SARAS_PROVIDER, ...config.router },
    }),
    askUser: false,
    cleanOutput: false,
    // Static imports: Pi's loader maps them to its own modules (dynamic import() is not mapped).
    typebox: Type,
    compact,
  })(pi);
  // SWA is always here (/swa works in any folder). Architect mode puts it first: its rules are in
  // every prompt. In Coder mode they join only for architecture work (a /swa run, or a folder that
  // already has SWA's arch/), and Pi's own edits are kept out of arch/ only in such a folder.
  const architect = config.mode === 'architect';
  await createSwaExtension({
    resources: swaResources(join(dirname(fileURLToPath(import.meta.url)), '..', 'swa')),
    typebox: Type,
    ...(!architect && {
      active: (prompt: string, store: ArchStore) =>
        /\bSWA\b|\bswa_\w+|\barch\//.test(prompt) || hasSwaFolder(store),
      guardFileTools: (cwd: string) => isSwaFolder(cwd),
    }),
  })(pi);
}

/** A folder whose arch/ is SWA's (it has SWA's inputs or approvals), not just any arch/ folder. */
function isSwaFolder(cwd: string): boolean {
  return ['inputs', '.swa'].some((d) => existsSync(join(cwd, 'arch', d)));
}

function hasSwaFolder(store: ArchStore): boolean {
  return store instanceof FsArchStore && isSwaFolder(dirname(store.root));
}
