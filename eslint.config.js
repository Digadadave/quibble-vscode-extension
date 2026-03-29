// @ts-check
const tsParser   = require('@typescript-eslint/parser');
const tsPlugin   = require('@typescript-eslint/eslint-plugin');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // ── Correctness ──────────────────────────────────────────────────────
      'eqeqeq':                             ['error', 'always'],
      'no-var':                             'error',
      'no-unused-expressions':              'error',
      '@typescript-eslint/no-unused-vars':  ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',

      // ── Style ────────────────────────────────────────────────────────────
      'prefer-const':                       'error',
      'no-console':                         'warn',
    },
  },
  {
    // Webview JS files — no TypeScript parser, looser rules
    files: ['media/**/*.js'],
    rules: {
      'eqeqeq':       ['error', 'always'],
      'no-var':       'error',
      'prefer-const': 'error',
      'no-console':   'warn',
    },
  },
];
