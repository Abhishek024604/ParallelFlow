// Saras agent runtime: RIC v0.2 over the Pi harness (ADR-035).
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

export const RUNTIME_VERSION = '0.1.0';

/** RIC Capabilities. */
export function capabilities(model: string) {
  return {
    runtime: 'tau',
    runtime_version: `saras-pi/${RUNTIME_VERSION}`,
    contract_version: '0.2.0',
    profiles: Object.entries(PROFILES).map(([name, description]) => ({
      name,
      description,
      models: [model],
    })),
    features: {
      steering: true,
      follow_up_queue: true,
      compaction: true,
      approvals: false,
      routines: true,
      assignments: true,
      artifacts: true,
    },
    limits: { max_input_chars: 20_000, max_concurrent_turns_per_session: 1 },
  };
}
