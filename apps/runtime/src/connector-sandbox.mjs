// Preloaded (`node --import`) into every connector process (connectors.ts), together with Node's
// permission model. A connector may not start programs: the child_process functions are replaced by
// stubs that fail the way a missing program does (an async 'error' event, or a throw for the Sync
// forms), so a server that tries to open a browser just logs it and carries on. Plain JavaScript:
// it runs in the connector's own node, before the package loads.
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';

const denied = (name) => {
  const err = new Error(`${name} is not allowed in a ParallelFlow connector`);
  err.code = 'EACCES';
  return err;
};

function blockedChild(name) {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: undefined,
    stdin: null,
    stdout: null,
    stderr: null,
    killed: false,
    exitCode: null,
    kill: () => false,
    unref: () => child,
    ref: () => child,
  });
  queueMicrotask(() => child.emit('error', denied(name)));
  return child;
}

for (const name of ['spawn', 'exec', 'execFile', 'fork']) {
  childProcess[name] = () => blockedChild(name);
}
for (const name of ['spawnSync', 'execSync', 'execFileSync']) {
  childProcess[name] = () => {
    throw denied(name);
  };
}
syncBuiltinESMExports();
