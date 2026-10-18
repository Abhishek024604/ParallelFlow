// Builds the Saras VS Code extension:
//   dist/extension.cjs          extension host (CommonJS, `vscode` external)
//   dist/webview.js + .css      sidebar webview (browser IIFE)
//   dist/guard/saras-guard.mjs  Pi extension (ESM; Pi supplies typebox and its own package)
//   dist/pi/                    Pi's self-contained CLI bundle plus jiti, which it needs to load extensions
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

function packageDir(name) {
  // pnpm links each dependency into node_modules; follow the link to the real files.
  return realpathSync(join(here, 'node_modules', name));
}

function copyPi() {
  const out = join(here, 'dist', 'pi');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'node_modules'), { recursive: true });
  cpSync(
    join(packageDir('@earendil-works/pi-coding-agent'), 'dist', 'bundle'),
    join(out, 'bundle'),
    {
      recursive: true,
    },
  );
  cpSync(packageDir('jiti'), join(out, 'node_modules', 'jiti'), { recursive: true });
}

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
};

const builds = [
  {
    ...common,
    entryPoints: [join(here, 'src', 'extension.ts')],
    outfile: join(here, 'dist', 'extension.cjs'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: [
      join(here, 'src', 'webview', 'main.ts'),
      join(here, 'src', 'webview', 'styles.css'),
    ],
    outdir: join(here, 'dist'),
    entryNames: 'webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
  {
    ...common,
    entryPoints: [join(here, 'src', 'guard', 'saras-guard.ts')],
    outfile: join(here, 'dist', 'guard', 'saras-guard.mjs'),
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['typebox', '@earendil-works/*'],
  },
];

copyPi();
if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
