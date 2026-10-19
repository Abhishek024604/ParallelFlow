import { mkdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONNECTORS, type ConnectorLaunch } from '@saras/pi-saras';

// How the runtime starts the enabled connectors (packages/pi-saras connectors.ts). Each one is a
// pinned dependency of this app, run with this process's node: never `npx`, never a download at
// start. Each runs sandboxed:
//   - Node's permission model: it may read only the installed packages and its own folder, write
//     only its own folder, and start no programs, workers or native addons;
//   - connector-sandbox.mjs (preloaded) turns child_process calls into a polite failure, so a server
//     that tries to open a browser logs it and carries on instead of failing the tool;
//   - an environment built from nothing (the transport does not inherit ours): it never sees
//     OPENROUTER_API_KEY, the runtime's signing keys or other sessions' data.
// The network stays open (draw.io's shape search fetches its index).

/** The connector names in RUNTIME_CONNECTORS, checked against the catalog. */
export function connectorNames(raw: string | undefined): string[] {
  const names = (raw ?? 'drawio')
    .split(',')
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  for (const name of names) {
    if (!CONNECTORS[name]) {
      throw new Error(
        `RUNTIME_CONNECTORS: unknown connector "${name}" (known: ${Object.keys(CONNECTORS).join(', ')})`,
      );
    }
  }
  return [...new Set(names)];
}

const require = createRequire(import.meta.url);

/** The launch for each enabled connector. Throws when a package is not installed. */
export function resolveConnectors(names: readonly string[], dataDir: string): ConnectorLaunch[] {
  return names.map((name) => {
    const connector = CONNECTORS[name];
    if (!connector) throw new Error(`Unknown connector ${name}`);
    const root = realpathSync(dirname(require.resolve(`${connector.package}/package.json`)));
    const home = join(dataDir, 'connectors', name);
    mkdirSync(join(home, 'tmp'), { recursive: true });
    mkdirSync(join(home, 'cache'), { recursive: true });
    // Real paths: the permission model compares resolved paths.
    const own = realpathSync(home);
    return {
      connector,
      command: process.execPath,
      args: [
        ...sandboxArgs({ packages: packagesDir(root), home: own, preload: PRELOAD }),
        join(root, connector.entry),
      ],
      env: { ...connector.env, ...connectorEnv(own) },
      cwd: own,
    };
  });
}

const PRELOAD = fileURLToPath(new URL('./connector-sandbox.mjs', import.meta.url));

/**
 * The folder that holds the package and its dependencies: pnpm's virtual store (`.pnpm`), else the
 * node_modules folder it is installed in.
 */
export function packagesDir(root: string): string {
  const store = `${sep}.pnpm${sep}`;
  const at = root.indexOf(store);
  if (at !== -1) return root.slice(0, at + store.length - 1);
  const modules = `${sep}node_modules${sep}`;
  const last = root.lastIndexOf(modules);
  return last === -1 ? root : root.slice(0, last + modules.length - 1);
}

/** Node flags: the permission model (reads, writes, no child processes) and the preload. */
export function sandboxArgs(paths: { packages: string; home: string; preload: string }): string[] {
  return [
    '--permission',
    `--allow-fs-read=${paths.packages}`,
    `--allow-fs-read=${paths.preload}`,
    `--allow-fs-read=${paths.home}`,
    `--allow-fs-write=${paths.home}`,
    '--import',
    pathToFileURL(paths.preload).href,
  ];
}

/** A minimal environment: a home and cache of its own; on Windows the system root node needs. */
export function connectorEnv(
  home: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string | undefined = process.env.SystemRoot,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    XDG_CACHE_HOME: join(home, 'cache'),
    // Temp files (draw.io writes one when it tries to open a browser) stay in the writable folder.
    TMPDIR: join(home, 'tmp'),
    NODE_ENV: 'production',
  };
  if (platform === 'win32') {
    Object.assign(env, {
      USERPROFILE: home,
      LOCALAPPDATA: join(home, 'cache'),
      TEMP: join(home, 'tmp'),
      TMP: join(home, 'tmp'),
      SystemRoot: systemRoot ?? 'C:\\Windows',
    });
  }
  return env;
}
