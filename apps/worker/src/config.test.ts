import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config.js';

const base = {
  DATABASE_URL: 'postgres://saras_api:pw@ep-x-pooler.example.com/saras',
  RELAY_DATABASE_URL: 'postgres://saras_relay_login:secret-pw@ep-x.example.com/saras',
};

describe('loadWorkerConfig', () => {
  it('uses the doc 05 defaults', () => {
    expect(loadWorkerConfig(base)).toMatchObject({
      logLevel: 'info',
      relay: { pollMs: 250, maxIdleMs: 2000, batchSize: 100 },
    });
  });

  it('requires both URLs', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(
      /RELAY_DATABASE_URL is not set/,
    );
    expect(() => loadWorkerConfig({ RELAY_DATABASE_URL: base.RELAY_DATABASE_URL })).toThrow(
      /DATABASE_URL is not set/,
    );
  });

  it('refuses a pooled relay URL and the app user as relay user, without echoing secrets', () => {
    const pooled = 'postgres://saras_relay_login:secret-pw@ep-x-pooler.example.com/saras';
    expect(() => loadWorkerConfig({ ...base, RELAY_DATABASE_URL: pooled })).toThrow(/direct/);
    const sameUser = 'postgres://saras_api:secret-pw@ep-x.example.com/saras';
    expect(() => loadWorkerConfig({ ...base, RELAY_DATABASE_URL: sameUser })).toThrow(
      /different user/,
    );
    try {
      loadWorkerConfig({ ...base, RELAY_DATABASE_URL: pooled });
    } catch (err) {
      expect((err as Error).message).not.toContain('secret-pw');
    }
  });

  it('validates the relay tuning knobs', () => {
    expect(loadWorkerConfig({ ...base, OUTBOX_BATCH_SIZE: '10' }).relay.batchSize).toBe(10);
    expect(() => loadWorkerConfig({ ...base, OUTBOX_BATCH_SIZE: '5000' })).toThrow();
    expect(() => loadWorkerConfig({ ...base, OUTBOX_POLL_MS: 'fast' })).toThrow();
    expect(() =>
      loadWorkerConfig({ ...base, OUTBOX_POLL_MS: '500', OUTBOX_IDLE_MAX_MS: '100' }),
    ).toThrow();
  });
});
