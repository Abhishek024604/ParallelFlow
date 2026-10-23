import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseCatalog, piModelsJson } from './openrouter-catalog.js';
import { PiEngine } from './pi-engine.js';

const NEW = 'newco/model-x:free';
const BODY = {
  data: [
    {
      id: NEW,
      name: 'NewCo: Model X (free)',
      context_length: 262_144,
      supported_parameters: ['tools', 'reasoning'],
      top_provider: { context_length: 262_144, max_completion_tokens: 235_929 },
    },
    { id: 'other/model', context_length: 8_000 },
  ],
};

describe('OpenRouter live catalog', () => {
  it('reads the limits of the asked models only', () => {
    expect(parseCatalog(BODY, [NEW, 'missing/model'])).toEqual([
      {
        id: NEW,
        name: 'NewCo: Model X (free)',
        contextWindow: 262_144,
        maxTokens: 235_929,
        reasoning: true,
      },
    ]);
    expect(parseCatalog({ data: [{ id: 'a/b' }] }, ['a/b'])[0]).toMatchObject({
      contextWindow: 128_000,
      maxTokens: 16_384,
      reasoning: false,
    });
    expect(parseCatalog('nonsense', [NEW])).toEqual([]);
  });
});

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const piNode = major > 22 || (major === 22 && minor >= 19);
const root = mkdtempSync(join(tmpdir(), 'saras-catalog-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.skipIf(!piNode)('Pi engine with a model newer than Pi’s OpenRouter list', () => {
  it('adds it from the catalog instead of skipping it', async () => {
    const asked: string[][] = [];
    const engine = new PiEngine({
      apiKey: 'sk-or-test',
      routing: { fast: [NEW], strong: [NEW], fallbacks: [] },
      dataDir: join(root, 'data'),
      catalog: async (ids) => {
        asked.push([...ids]);
        return parseCatalog(BODY, ids);
      },
    });
    await engine.init();
    expect(asked).toEqual([[NEW]]);
    expect(engine.unavailableReason()).toBeNull();
    expect(engine.addedModels).toEqual([NEW]);
    expect(engine.unknownModels).toEqual([]);
    expect(engine.model).toBe(NEW);
    const written = readFileSync(join(root, 'data', 'pi-models.json'), 'utf8');
    expect(written).toBe(piModelsJson(parseCatalog(BODY, [NEW])));
    expect(written).not.toContain('sk-or-test');
  });
});
