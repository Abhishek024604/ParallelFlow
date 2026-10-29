import { describe, expect, it } from 'vitest';
import { arenaFolderName, defaultBuildFolder, parseStartLink } from './start-link.js';

const ARENA = '0190f5a2-1c2d-7e3f-8a9b-0c1d2e3f4a5b';
const CODE = 'Abc_def-1234567890123456';

describe('"Build in VS Code" link', () => {
  it('reads the link the web app makes, and knows when it is for this server', () => {
    // As contracts vscodeStartLink makes it (the extension does not import contracts).
    const link = `vscode://parallelflow.parallelflow-vscode/start?arena=${ARENA}&code=${CODE}&web=https%3A%2F%2Fapp.example.com`;
    expect(link.startsWith('vscode://parallelflow.parallelflow-vscode/start?')).toBe(true);
    const query = link.slice(link.indexOf('?') + 1);
    expect(parseStartLink(query, 'https://app.example.com/')).toEqual({
      arenaId: ARENA,
      code: CODE,
      web: 'https://app.example.com',
      sameServer: true,
    });
    expect(parseStartLink(query, 'http://localhost:3000')?.sameServer).toBe(false);
  });

  it('refuses links that are not well formed', () => {
    expect(parseStartLink(`arena=nope&code=${CODE}&web=https://a.b`, 'https://a.b')).toBeNull();
    expect(parseStartLink(`arena=${ARENA}&code=x&web=https://a.b`, 'https://a.b')).toBeNull();
    expect(parseStartLink(`arena=${ARENA}&web=javascript:alert(1)`, 'https://a.b')).toBeNull();
  });

  it('builds in ~/ParallelFlow/<arena>', () => {
    expect(arenaFolderName({ key: 'SHOP', name: 'Shop app' })).toBe('shop');
    expect(arenaFolderName({ key: null, name: 'Café Orders 2.0' })).toBe('cafe-orders-2-0');
    expect(defaultBuildFolder('/home/a', { name: 'X' }).replace(/\\/g, '/')).toBe(
      '/home/a/ParallelFlow/x',
    );
  });
});
