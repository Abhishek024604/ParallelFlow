// `pnpm dev`: web, API and App Tools through turbo; the agent runtime as a plain child process.
// The runtime is kept out of turbo because loading the Pi harness hangs under turbo's task runner on
// Windows (it loads in ~3 s when started directly). Its output is prefixed like turbo's.
// For a fast app without on-demand compiling, use `pnpm demo` (production build + next start).
import { start } from './procs.mjs';

start(['exec', 'turbo', 'run', 'dev', '--filter=!@parallelflow/worker', '--filter=!@parallelflow/runtime']);
start(['--filter', '@parallelflow/runtime', 'dev'], { prefix: '@parallelflow/runtime:dev: ' });
