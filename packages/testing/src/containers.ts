import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { getContainerRuntimeClient } from 'testcontainers';

// Same images as docker-compose.yml, so tests and local dev run the same engines.
export const POSTGRES_IMAGE = 'pgvector/pgvector:pg16';
export const REDIS_IMAGE = 'redis:7-alpine';

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  url: string;
}

export interface TestRedis {
  container: StartedRedisContainer;
  url: string;
}

/**
 * True when a container runtime is reachable.
 * In CI a missing runtime is an error, so integration tests can never silently skip there.
 */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await getContainerRuntimeClient();
    return true;
  } catch (err) {
    if (process.env.CI) {
      throw new Error('Docker is required for integration tests in CI', { cause: err });
    }
    console.warn('Docker not available: skipping integration tests locally.');
    return false;
  }
}

export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withDatabase('parallelflow_test')
    .withUsername('parallelflow')
    .withPassword('parallelflow')
    .start();
  return { container, url: container.getConnectionUri() };
}

export async function startRedis(): Promise<TestRedis> {
  const container = await new RedisContainer(REDIS_IMAGE).start();
  return { container, url: container.getConnectionUrl() };
}
