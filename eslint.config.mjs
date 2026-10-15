import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
