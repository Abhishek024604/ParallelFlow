// `pnpm dev`: web, API and App Tools through turbo; the agent runtime as a plain child process.
// The runtime is kept out of turbo because loading the Pi harness hangs under turbo's task runner on
// Windows (it loads in ~3 s when started directly). Its output is prefixed like turbo's.
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
const children = [];

function start(args, { prefix } = {}) {
  const child = spawn(pnpm, args, {
    stdio: prefix ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: isWindows,
    env: process.env,
  });
  if (prefix) {
    for (const stream of [child.stdout, child.stderr]) {
      let buffered = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
      });
    }
  }
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`${prefix ?? ''}exited with code ${code ?? 'null'}; stopping dev`);
      stop(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (isWindows) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start(['exec', 'turbo', 'run', 'dev', '--filter=!@saras/worker', '--filter=!@saras/runtime']);
start(['--filter', '@saras/runtime', 'dev'], { prefix: '@saras/runtime:dev: ' });
