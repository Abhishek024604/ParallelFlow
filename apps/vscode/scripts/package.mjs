// Builds a .vsix. vsce rejects scoped package names and pnpm's symlinked node_modules, so the
// production build is staged in dist/vsix-stage with a plain name and no dependencies (everything
// is bundled), then packed with vsce through npx (no global install).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'dist', 'vsix-stage');
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

run('node', ['esbuild.mjs', '--production'], root);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });
for (const f of [
  'extension.cjs',
  'webview.js',
  'webview.css',
  'guard',
  'agent',
  'skills',
  'prompts',
  'swa',
  'pi',
]) {
  cpSync(join(root, 'dist', f), join(stage, 'dist', f), { recursive: true });
}
cpSync(join(root, 'media'), join(stage, 'media'), { recursive: true });
cpSync(join(root, 'README.md'), join(stage, 'README.md'));
cpSync(join(root, '.vscodeignore'), join(stage, '.vscodeignore'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
pkg.name = 'parallelflow-vscode';
delete pkg.private;
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
run(
  'npx',
  [
    '--yes',
    '@vscode/vsce@3.2.2',
    'package',
    '--no-dependencies',
    '--allow-missing-repository',
    '--skip-license',
    '-o',
    join(root, 'dist', 'parallelflow.vsix'),
  ],
  stage,
);
