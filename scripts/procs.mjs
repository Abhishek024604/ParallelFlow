// Child processes for `pnpm dev` and `pnpm demo`: start pnpm commands, prefix their output, and stop
// them all (with their process trees on Windows) when one exits or on Ctrl+C.
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const pnpm = isWindows ? 'pnpm.cmd' : 'pnpm';
const children = [];
let stopping = false;

/** Runs `pnpm <args>` to completion (inherited output); resolves with its exit code. */
export function run(args) {
  return new Promise((resolve) => {
    const child = spawn(pnpm, args, { stdio: 'inherit', shell: isWindows, env: process.env });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** Starts a long-running `pnpm <args>`; if it exits, everything stops. */
export function start(args, { prefix } = {}) {
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
      console.error(`${prefix ?? ''}exited with code ${code ?? 'null'}; stopping`);
      stop(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

export function stop(code = 0) {
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
