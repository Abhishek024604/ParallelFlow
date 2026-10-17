// `pnpm demo`: the app as it runs for a demo. Builds the web app once (`next build`), then runs the
// web with `next start` (no on-demand compiling: pages answer in milliseconds, not seconds) next to
// the API, App Tools and the agent runtime, without file watchers. None of them run under turbo (the
// runtime hangs under turbo on Windows, see dev.mjs).
//   pnpm demo              build, then start everything
//   pnpm demo --no-build   start with the last build (after changing web code, build again)
// Ports and URLs come from .env.local like `pnpm dev` (web 3000, API 4000, App Tools 4200, runtime
// 7070). The worker is left out, as in `pnpm dev`.
import { run, start } from './procs.mjs';

// Its own build folder (next.config.ts distDir): building never breaks a running `pnpm dev`.
process.env.NEXT_DIST_DIR ??= '.next-demo';

if (!process.argv.includes('--no-build')) {
  console.warn('demo: building the web app (next build)…');
  const code = await run(['--filter', '@saras/web', 'build']);
  if (code !== 0) {
    console.error('demo: the web build failed; nothing started');
    process.exit(code);
  }
}

start(['--filter', '@saras/api', 'start'], { prefix: '@saras/api: ' });
start(['--filter', '@saras/app-tools', 'start'], { prefix: '@saras/app-tools: ' });
start(['--filter', '@saras/runtime', 'start'], { prefix: '@saras/runtime: ' });
start(['--filter', '@saras/web', 'start'], { prefix: '@saras/web: ' });
