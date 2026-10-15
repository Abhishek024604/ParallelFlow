import { defineConfig } from 'vitest/config';
import { testDatabaseEnv } from './vitest.workspace.js';

// Global options for the projects in vitest.workspace.ts. Vitest 2 only accepts the fork limit here,
// not per project.
//
// With TEST_DATABASE_URL (a remote server such as Neon), every integration file shares one server and
// one connection limit; each file opens its own pools on top of migrating a fresh database. The
// default (one fork per core but one) puts all 7 database files on it at once. Four forks keep the
// longest file (auth, ~12 min from India) as the critical path while the others share three forks,
// so the total stays about the same with roughly half the concurrent load. Without TEST_DATABASE_URL
// (CI) each file has its own Testcontainers Postgres, so nothing is shared and nothing is capped.
const REMOTE_DB_MAX_FORKS = 4;

export default defineConfig({
  test: {
    poolOptions: {
      // minForks defaults to cores - 1 and must not exceed maxForks.
      forks: testDatabaseEnv().TEST_DATABASE_URL
        ? { minForks: 1, maxForks: REMOTE_DB_MAX_FORKS }
        : {},
    },
  },
});
