// Environment scrubbing for Pi and the shell commands it runs. Pi gets an allowlisted environment
// (no API keys, database URLs, cloud or GitHub credentials), and temp files go to a folder-local
// directory. A second check drops anything that looks like a secret even if its name is allowed.

const ALLOWED = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'COLORTERM',
  'TZ',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'OS',
  'PROCESSOR_ARCHITECTURE',
  'NUMBER_OF_PROCESSORS',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'PUBLIC',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
] as const;

const ALLOWED_SET = new Set<string>(ALLOWED);

/** Names that carry credentials or connection strings. Never passed on, whatever the allowlist says. */
const SECRET_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD_|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|_URL$|_URI$|DSN|CONN)|^(AWS_|AZURE_|GCP_|GOOGLE_|GITHUB_|GH_|GITLAB_|OPENAI|OPENROUTER|ANTHROPIC|HF_|HUGGING|NPM_|NODE_OPTIONS|NODE_PATH|DATABASE|PG|MYSQL|REDIS|MONGO|WORKOS|SENTRY|POSTHOG|SSH_|GPG_|DOCKER_|KUBE|VSCODE_|ELECTRON_|SARAS_)/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

export interface ScrubOptions {
  /** Folder-local temp directory (TEMP, TMP and TMPDIR all point here). */
  tmpDir: string;
  /** Extra variables set by the caller after scrubbing (for example PI_* configuration). */
  set?: Record<string, string>;
}

export function scrubEnv(
  source: Readonly<Record<string, string | undefined>>,
  options: ScrubOptions,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!ALLOWED_SET.has(name.toUpperCase())) continue;
    if (isSecretName(name)) continue;
    out[name] = value;
  }
  out.TEMP = options.tmpDir;
  out.TMP = options.tmpDir;
  out.TMPDIR = options.tmpDir;
  out.GIT_TERMINAL_PROMPT = '0';
  for (const [name, value] of Object.entries(options.set ?? {})) out[name] = value;
  return out;
}
