// `pnpm demo:check`: is everything ready to film? Checks .env.local, every OpenRouter key in the
// pool, the models, the GitHub App settings, the running services and the VS Code extension
// download. Prints ✓ / ✗ per check and never prints a key, secret or token (keys by number only).
//   pnpm demo:check          no AI calls
//   pnpm demo:check --live   also one tiny chat call per key on RUNTIME_MODEL (uses 1 call each)
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const live = process.argv.includes('--live');
for (const file of ['.env.local', '.env']) {
  try {
    process.loadEnvFile(new URL(file, root));
  } catch {
    // optional
  }
}
const env = process.env;
let failed = 0;
const say = (line) =>
  process.stdout.write(`${line}
`);
const ok = (msg) => say(`  ✓ ${msg}`);
const bad = (msg, fix) => {
  failed += 1;
  say(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ''}`);
};
const warn = (msg) => say(`  ! ${msg}`);
const section = (name) => say(`\n${name}`);

async function get(url, init = {}, ms = 8000) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch {
    return null;
  }
}

// Same rules as runtime-client key-pool.ts poolKeys().
const keys = [
  ...new Set(
    [...(env.OPENROUTER_API_KEYS ?? '').split(/[\s,;]+/), env.OPENROUTER_API_KEY ?? ''].map((k) =>
      k.trim(),
    ),
  ),
].filter((k) => k && !k.startsWith('#'));

section('AI keys (OpenRouter)');
if (!keys.length) bad('no keys', 'set OPENROUTER_API_KEYS=key1,key2,… in .env.local');
else ok(`${keys.length} keys in the pool (${keys.length * 50} free calls a day at 50 each)`);
let usable = 0;
for (const [i, key] of keys.entries()) {
  const res = await get('https://openrouter.ai/api/v1/key', {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!res) {
    bad(`key ${i + 1}: OpenRouter could not be reached`);
    continue;
  }
  if (res.status !== 200) {
    bad(`key ${i + 1}: refused (${res.status})`, 'revoked or mistyped: replace it');
    continue;
  }
  usable += 1;
  const data = (await res.json().catch(() => ({})))?.data ?? {};
  const tier = data.is_free_tier ? 'free tier' : 'paid tier';
  ok(`key ${i + 1}: valid, ${tier}`);
}
if (keys.length && usable < keys.length) warn(`${keys.length - usable} key(s) unusable`);

section('Models');
const models = [
  env.RUNTIME_MODEL,
  ...(env.RUNTIME_FALLBACK_MODELS ?? '').split(','),
  env.RUNTIME_MODEL_FAST,
  env.RUNTIME_MODEL_STRONG,
]
  .map((m) => (m ?? '').trim())
  .filter(Boolean);
if (!env.RUNTIME_MODEL) bad('RUNTIME_MODEL is not set');
const catalog = await get('https://openrouter.ai/api/v1/models');
const ids = new Set(
  catalog?.ok ? ((await catalog.json().catch(() => ({})))?.data ?? []).map((m) => m.id) : [],
);
for (const m of new Set(models)) {
  if (!ids.size) warn(`${m}: catalog not reachable, not checked`);
  else if (ids.has(m) || m === 'openrouter/free' || m === 'openrouter/auto') ok(m);
  else bad(`${m}: not in OpenRouter's catalog`, 'check the id on openrouter.ai/models');
}
if (live && env.RUNTIME_MODEL) {
  for (const [i, key] of keys.entries()) {
    const res = await get(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: env.RUNTIME_MODEL,
          max_tokens: 5,
          messages: [{ role: 'user', content: 'Say ok' }],
        }),
      },
      60_000,
    );
    if (res?.ok) ok(`key ${i + 1}: ${env.RUNTIME_MODEL} answers`);
    else if (res?.status === 429) warn(`key ${i + 1}: rate limited now (429), the pool skips it`);
    else bad(`key ${i + 1}: chat call failed (${res ? res.status : 'no answer'})`);
  }
}

section('GitHub App');
const gh = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
];
const missing = gh.filter((k) => !env[k]);
if (missing.length) bad(`not set: ${missing.join(', ')}`, 'see docs/github-app-setup.md');
else {
  if (/^\d+$/.test(env.GITHUB_APP_ID)) ok('App ID');
  else bad('GITHUB_APP_ID is not a number');
  if (/^[a-z0-9-]+$/.test(env.GITHUB_APP_SLUG)) ok('slug');
  else bad('GITHUB_APP_SLUG is not a slug');
  try {
    createPrivateKey(env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'));
    ok('private key');
  } catch {
    bad('GITHUB_APP_PRIVATE_KEY is not a valid PEM', 'write it on one line with \\n');
  }
  if (env.GITHUB_WEBHOOK_SECRET.length >= 20) ok('webhook secret');
  else bad('GITHUB_WEBHOOK_SECRET is shorter than 20 characters');
}
warn(
  'webhooks: keep `npx smee-client --url <channel> --target http://localhost:4000/v1/github/webhook` running',
);

section('Services (start them with `pnpm demo` or `pnpm dev`)');
const web = await get('http://localhost:3000/sign-in');
if (web && web.status < 500) ok('web  :3000');
else bad('web :3000 is not answering');
const api = await get('http://localhost:4000/v1/health');
if (api?.ok) ok('API  :4000');
else bad('API :4000 is not answering', 'look for a startup error in its log');
const runtimeUrl = new URL(env.RUNTIME_URL || 'http://localhost:7070').origin;
const rt = await get(`${runtimeUrl}/v1/health`);
const rtBody = rt ? await rt.json().catch(() => ({})) : null;
if (!rt) bad(`runtime ${runtimeUrl} is not answering`);
else if (rtBody?.checks?.model === 'ok') ok('runtime (AI ready)');
else
  bad(`runtime is up but the AI is ${rtBody?.checks?.model ?? 'unknown'}`, 'see the runtime log');
const tools = await get('http://localhost:4200/health');
if (tools) ok('App Tools :4200');
else warn('App Tools :4200 did not answer /health (the AI cannot use arena tools without it)');

section('VS Code extension');
const vsix = new URL('apps/web/public/downloads/parallelflow.vsix', root);
if (!existsSync(vsix)) bad('no download yet', 'pnpm --filter @parallelflow/vscode package');
else {
  // The extension's last committed change (file times change on checkout), or now when it has
  // uncommitted changes.
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const dirty = git(['status', '--porcelain', '--', 'apps/vscode']) !== '';
  const src = dirty
    ? Date.now()
    : Number(git(['log', '-1', '--format=%ct', '--', 'apps/vscode'])) * 1000;
  if (statSync(vsix).mtimeMs >= src) ok('download is up to date');
  else
    bad(
      'download is older than the extension code',
      'pnpm --filter @parallelflow/vscode package, then reinstall it in VS Code',
    );
}

say(failed ? `\n${failed} problem(s) to fix before filming.` : '\nReady to film.');
process.exit(failed ? 1 : 0);
