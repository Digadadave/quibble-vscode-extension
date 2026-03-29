// @ts-check
const tsParser   = require('@typescript-eslint/parser');
const tsPlugin   = require('@typescript-eslint/eslint-plugin');

/** @type {import('eslint').Linter.Config[]} */
module.exports = [
  {
    // TypeScript source files only — the TS parser is required for type-aware rules.
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json', // enables type-aware lint rules
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // ── Correctness ──────────────────────────────────────────────────────

      // Require === / !== instead of == / !=. Prevents subtle type-coercion bugs
      // (e.g. null == undefined is true, which is almost never what you want).
      'eqeqeq': ['error', 'always'],

      // Disallow var — var has function scope and hoisting, which causes confusing
      // bugs. Use const or let (block-scoped) instead.
      'no-var': 'error',

      // Flag expressions whose result is never used (e.g. `a && b;` with no
      // assignment). These are almost always bugs or leftover debugging code.
      'no-unused-expressions': 'error',

      // Error on variables/args that are declared but never read. Catches dead code
      // and typos. Prefix with _ to explicitly mark something intentionally unused.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],

      // Warn when `any` is used explicitly. TypeScript's whole point is type safety;
      // `any` opts out of it. Warn rather than error so it can be used in a pinch.
      '@typescript-eslint/no-explicit-any': 'warn',

      // ── Style ────────────────────────────────────────────────────────────

      // Require const when a variable is never reassigned. Signals immutability
      // intent and prevents accidental reassignment.
      'prefer-const': 'error',

      // Warn on console.log/warn/error left in source. These are fine during
      // development but shouldn't ship in production extension code. Warn rather
      // than error so existing console calls don't block the build.
      'no-console': 'warn',
    },
  },
  {
    // Webview JS files — no TypeScript parser, so only plain JS rules apply.
    files: ['media/**/*.js'],
    rules: {
      'eqeqeq':       ['error', 'always'],
      'no-var':       'error',
      'prefer-const': 'error',
      'no-console':   'warn',
    },
  },
];
