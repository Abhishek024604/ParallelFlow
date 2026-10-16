import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// apps/api files allowed to call withTenant (they create the org in the same transaction). Each entry
// needs a comment naming the story or ADR, e.g.
//   'apps/api/src/arena/create-arena.service.ts', // ADR-029: creates the hidden org
const TENANT_CREATION_ALLOWLIST = [];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'docs/**',
      'claude-setup/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // doc 11 §11.2: no `any` without a comment explaining why.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // Tests may assert presence with `!`: a wrong guess fails the test, which is the point.
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  // doc 11 §11.2: every query runs inside withTenant. Apps get the database only via @saras/db.
  {
    files: ['apps/**/*.{ts,tsx}'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'pg', message: 'Use createDatabase() from @saras/db (withTenant).' },
            {
              name: 'kysely',
              importNames: ['Kysely', 'PostgresDialect'],
              message: 'Use createDatabase() from @saras/db (withTenant).',
            },
          ],
          patterns: [{ group: ['@saras/db/testing'], message: 'Test helpers only.' }],
        },
      ],
    },
  },
  // ADR-031 / F21-04: API code gets its tenant only from a verified membership. The request pipeline
  // opens withUser / withProjectMember / withOrgMember for handlers; nothing in apps/api may call the
  // unchecked withTenant or the RLS-widening withSystemJob.
  // Allowlist: flows that create the org themselves (create arena, ADR-029) go in
  // TENANT_CREATION_ALLOWLIST below, each with a comment and an ADR or story id. None yet.
  {
    files: ['apps/api/**/*.ts'],
    ignores: ['**/*.test.ts', ...TENANT_CREATION_ALLOWLIST],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(withTenant|withSystemJob)$/], MemberExpression[property.value=/^(withTenant|withSystemJob)$/]',
          message:
            'API code resolves the tenant via the pipeline (@ProjectScoped / @OrgScoped → withProjectMember / withOrgMember). withTenant and withSystemJob are not allowed in apps/api (ADR-031).',
        },
        {
          selector: 'ObjectPattern > Property[key.name=/^(withTenant|withSystemJob)$/]',
          message: 'Do not destructure withTenant / withSystemJob in apps/api (ADR-031).',
        },
      ],
    },
  },
  // F21-05 / ADR-033: the worker acts for no user. Consumers run in withSystemJob for the event's org
  // (the org comes from a validated outbox event, which RLS tied to its tenant when it was written);
  // the relay and housekeeping use the narrow relay accessor. No user-facing or unchecked contexts.
  {
    files: ['apps/worker/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MemberExpression[property.name=/^(withTenant|withUser|withIdentity|withOrgMember|withProjectMember)$/]',
          message:
            'The worker uses withSystemJob (consumers) or the relay accessor only (F21-05, ADR-033).',
        },
        {
          selector:
            'ObjectPattern > Property[key.name=/^(withTenant|withUser|withIdentity|withOrgMember|withProjectMember)$/]',
          message: 'Do not destructure user or unchecked contexts in apps/worker (ADR-033).',
        },
      ],
    },
  },
  // doc 05 §5.3 / doc 11 §11.2: apps import packages; packages never import apps.
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*', capture: ['name'] },
        { type: 'package', pattern: 'packages/*', capture: ['name'] },
      ],
      'boundaries/dependency-nodes': ['import', 'dynamic-import'],
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['tsconfig.base.json', '{apps,packages}/*/tsconfig.json'],
        },
      },
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'app', allow: ['package', ['app', { name: '${from.name}' }]] },
            { from: 'package', allow: ['package'] },
          ],
        },
      ],
    },
  },
);
