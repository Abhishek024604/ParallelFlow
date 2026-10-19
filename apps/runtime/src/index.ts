// Saras agent runtime: RIC v0.2 over the Pi harness (ADR-035).
import { commandsFor, PROFILE_SKILLS, type SarasConnector } from '@saras/pi-saras';
import { PROFILES } from './profiles.js';

export * from './agent.js';
export * from './app-tools.js';
export * from './config.js';
export * from './event-log.js';
export * from './http.js';
export * from './mapping.js';
export * from './pi-engine.js';
export * from './profiles.js';
export * from './service.js';
export * from './store.js';

export const RUNTIME_VERSION = '0.2.0';

/**
 * RIC Capabilities. v0.2.1 adds (all optional): profiles[].commands (slash commands = Pi prompt
 * templates) and profiles[].skills, and features.ephemeral_fork / commands / questions.
 */
export function capabilities(
  models: string | readonly string[],
  connectors: readonly SarasConnector[] = [],
) {
  const list = typeof models === 'string' ? [models] : [...models];
  return {
    runtime: 'tau',
    runtime_version: `saras-pi/${RUNTIME_VERSION}`,
    contract_version: '0.2.1',
    profiles: Object.entries(PROFILES).map(([name, description]) => ({
      name,
      description,
      models: list,
      commands: commandsFor(name as keyof typeof PROFILES),
      skills: [...PROFILE_SKILLS[name as keyof typeof PROFILES]],
    })),
    features: {
      steering: true,
      follow_up_queue: true,
      compaction: true,
      approvals: false,
      routines: true,
      assignments: true,
      artifacts: true,
      ephemeral_fork: true,
      commands: true,
      questions: true,
      connectors: connectors.length > 0,
    },
    /** v0.2.1 (optional): external MCP servers the harness runs, with the tools it allows. */
    connectors: connectors.map((c) => ({
      name: c.name,
      description: c.description,
      tools: Object.keys(c.tools),
      profiles: [...c.profiles],
    })),
    limits: { max_input_chars: 20_000, max_concurrent_turns_per_session: 1 },
  };
}
