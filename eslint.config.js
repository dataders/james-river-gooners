import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.vite', 'node_modules']),
  {
    files: ['playwright.config.js', 'playwright.*.config.js', 'tests/**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
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
])
