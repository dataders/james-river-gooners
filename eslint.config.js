import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude` holds nested git worktrees (agent workspaces) — full repo
  // checkouts that must never be linted as part of this tree's `eslint .`.
  globalIgnores(['dist', '.vite', 'node_modules', '.claude']),
  // TypeScript files (the migration is incremental — most of the tree is still
  // .js/.jsx; see tsconfig.json). Type-aware linting: `recommendedTypeChecked`
  // + `projectService` pull in the type-checker so rules like
  // no-floating-promises / no-misused-promises / no-unsafe-* can catch bugs
  // `tsc --noEmit` won't (unawaited promises, `any` leaking in from untyped
  // JSON). Slower than syntax-only lint, but scoped to the .ts/.tsx files the
  // migration has reached, so it stays cheap until coverage grows.
  {
    // Scoped to src/ (the SPA migration target); the Deno edge functions under
    // supabase/functions have their own runtime + console conventions.
    files: ['src/**/*.{ts,tsx}'],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-unneeded-ternary': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // verbatimModuleSyntax is on (tsconfig); enforce `import type` to match.
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // node:test's `test(...)` returns a Promise the runner itself awaits, so a
    // top-level `test(...)` call is a floating promise by design — the rule is
    // a false positive for the whole test-runner idiom.
    files: ['src/**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      // Correctness
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-throw-literal': 'error',
      'no-unneeded-ternary': 'error',
      'no-implicit-coercion': ['error', { allow: ['!!'] }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Encourage typedef hints / discourage silent `any`-style holes
      'valid-typeof': 'error',
    },
  },
  // Node.js scripts and test infrastructure — need process/console/etc.
  {
    files: ['playwright.config.js', 'playwright.*.config.js', 'tests/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
])
