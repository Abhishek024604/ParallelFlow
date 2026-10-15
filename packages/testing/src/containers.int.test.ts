import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dockerAvailable,
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from './containers.js';

const enabled = await dockerAvailable();

describe.skipIf(!enabled)('Testcontainers harness', () => {
  let postgres: TestPostgres;
  let redis: TestRedis;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  });

  afterAll(async () => {
    await Promise.all([postgres?.container.stop(), redis?.container.stop()]);
  });

  it('runs Postgres 16 with pgvector', async () => {
    const client = new pg.Client({ connectionString: postgres.url });
    await client.connect();
    try {
      const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      expect(Number(version.rows[0]?.server_version_num)).toBeGreaterThanOrEqual(160000);

      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      const distance = await client.query<{ d: number }>(
        "SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS d",
      );
      expect(distance.rows[0]?.d).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('runs Redis 7 with pub/sub', async () => {
    const pub = new Redis(redis.url);
    const sub = new Redis(redis.url);
    try {
      expect(await pub.ping()).toBe('PONG');

      const received = new Promise<string>((resolve) => {
        sub.on('message', (_channel, message: string) => resolve(message));
      });
      await sub.subscribe('f21-01');
      await pub.publish('f21-01', 'hello');
      expect(await received).toBe('hello');
    } finally {
      pub.disconnect();
      sub.disconnect();
    }
  });
});
