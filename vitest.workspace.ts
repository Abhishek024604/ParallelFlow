import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineWorkspace } from 'vitest/config';

// Integration tests may use TEST_DATABASE_URL from .env.local (e.g. a Neon branch) instead of Docker.
// Only that variable is passed through; CI sets nothing and uses Testcontainers.
export function testDatabaseEnv(): Record<string, string> {
  if (process.env.TEST_DATABASE_URL) return { TEST_DATABASE_URL: process.env.TEST_DATABASE_URL };
  try {
    const url = parseEnv(readFileSync('.env.local', 'utf8')).TEST_DATABASE_URL;
    return url ? { TEST_DATABASE_URL: url } : {};
  } catch {
    return {};
  }
}

// Unit tests run everywhere and need no services.
// Integration tests (*.int.test.ts) need a real Postgres: TEST_DATABASE_URL or Docker.
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
      env: testDatabaseEnv(),
      testTimeout: 120_000,
      hookTimeout: 180_000,
      pool: 'forks',
    },
  },
]);
