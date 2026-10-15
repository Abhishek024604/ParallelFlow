import { defineWorkspace } from 'vitest/config';

// Unit tests run everywhere and need no services.
// Integration tests (*.int.test.ts) start real containers via Testcontainers and need Docker.
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['{apps,packages}/*/src/**/*.test.ts'],
      exclude: ['**/*.int.test.ts', '**/node_modules/**'],
      environment: 'node',
    },
  },
  {
    test: {
      name: 'integration',
      include: ['{apps,packages}/*/src/**/*.int.test.ts'],
      environment: 'node',
      testTimeout: 120_000,
      hookTimeout: 180_000,
      pool: 'forks',
    },
  },
]);
