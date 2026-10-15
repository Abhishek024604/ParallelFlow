import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from './database.js';

describe('createDatabase', () => {
  it('survives an idle connection closed by the server and reports only name and SQLSTATE', async () => {
    const pool = new pg.Pool();
    const onIdleConnectionError = vi.fn();
    const db = createDatabase({ pool, onIdleConnectionError });
    try {
      const err = Object.assign(new Error('terminating connection for user secret'), {
        code: '57P01',
      });
      // Without a listener, EventEmitter throws on an unhandled 'error' event.
      expect(() => pool.emit('error', err, {} as pg.PoolClient)).not.toThrow();
      expect(onIdleConnectionError).toHaveBeenCalledWith({ name: 'Error', code: '57P01' });
    } finally {
      await db.destroy();
    }
  });

  it('ignores idle connection errors when no callback is given', async () => {
    const pool = new pg.Pool();
    const db = createDatabase({ pool });
    try {
      expect(() => pool.emit('error', new Error('x'), {} as pg.PoolClient)).not.toThrow();
    } finally {
      await db.destroy();
    }
  });
});
