import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from './migrator.js';

const contract = new URL('../../../docs/contracts/schema_v2.sql', import.meta.url);

describe('migrations', () => {
  it('baseline is byte-identical to docs/contracts/schema_v2.sql', async () => {
    const [baseline, schema] = await Promise.all([
      readFile(new URL('0001_baseline.up.sql', MIGRATIONS_DIR), 'utf8'),
      readFile(contract, 'utf8'),
    ]);
    expect(baseline).toBe(schema);
  });

  it('every migration has an up and a down file, numbered without gaps', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const names = [...new Set(files.map((f) => f.replace(/\.(up|down)\.sql$/, '')))];

    for (const name of names) {
      expect(files).toContain(`${name}.up.sql`);
      expect(files).toContain(`${name}.down.sql`);
    }
    expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(names.map((_, i) => i + 1));
  });
});
