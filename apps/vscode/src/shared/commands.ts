// Shell command allowlist. Only a plain command (one program, literal arguments) can be
// auto-approved; anything a shell would interpret (chaining, pipes, substitution, redirects,
// variables, globs that brace-expand, escapes, comments) always goes to the person.

/** Characters a shell treats specially. Their presence anywhere, even quoted, means "ask". */
const SHELL_META = /[;&|`$<>(){}\n\r!#^%\\]|\p{Cc}/u;

/** Wildcards could expand to paths outside the folder (for example `.*` matches `..`). */
const GLOB = /[*?[\]]/;

export function isCompound(command: string): boolean {
  return SHELL_META.test(command);
}

/** Split on whitespace with '…' and "…" quoting. Returns null for unbalanced quotes. */
export function tokenize(command: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = '';
      inToken = false;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) return null;
  if (inToken) tokens.push(current);
  return tokens;
}

export interface AllowlistDecision {
  auto: boolean;
  /** Which entry matched, or why the command needs a person. */
  reason: string;
}

/**
 * Decide whether `command` runs without asking. An entry matches the exact token sequence; an
 * entry ending in " *" also matches extra arguments, each of which (and each `--flag=value` value)
 * must pass `isPathInside`, so `cat ../secret` or `git diff --output=/tmp/x` still ask.
 */
export function matchAllowlist(
  command: string,
  allowlist: readonly string[],
  isPathInside: (arg: string) => boolean,
): AllowlistDecision {
  const trimmed = command.trim();
  if (trimmed === '') return { auto: false, reason: 'Empty command' };
  if (isCompound(trimmed)) {
    return {
      auto: false,
      reason: 'Uses shell features (chaining, pipes, substitution or redirects)',
    };
  }
  if (GLOB.test(trimmed)) return { auto: false, reason: 'Uses wildcards' };
  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return { auto: false, reason: 'Unbalanced quotes' };
  if ((tokens[0] ?? '').includes('=')) return { auto: false, reason: 'Sets environment variables' };

  for (const entry of allowlist) {
    const wildcard = entry.trimEnd().endsWith(' *');
    const base = tokenize(wildcard ? entry.trimEnd().slice(0, -2) : entry.trim());
    if (!base || base.length === 0) continue;
    if (tokens.length < base.length) continue;
    if (!base.every((t, i) => t === tokens[i])) continue;
    const extra = tokens.slice(base.length);
    if (extra.length === 0) return { auto: true, reason: `Allowed: ${entry}` };
    if (!wildcard) continue;
    const bad = extra.find((arg) => !argIsSafe(arg, isPathInside));
    if (bad === undefined) return { auto: true, reason: `Allowed: ${entry}` };
  }
  return { auto: false, reason: 'Not on the allowlist' };
}

function argIsSafe(arg: string, isPathInside: (arg: string) => boolean): boolean {
  if (arg.startsWith('-')) {
    const eq = arg.indexOf('=');
    return eq === -1 ? true : isPathInside(arg.slice(eq + 1) || '.');
  }
  return isPathInside(arg);
}
