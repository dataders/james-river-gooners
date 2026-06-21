import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Component/hook tests run under jsdom via Vitest. The pure-function utils keep
// using the zero-dependency `node --test` suite (`npm run test:unit`); Vitest
// owns anything that needs React rendering (`*.vitest.{jsx,tsx}`), so the two
// suites never collide on the same files.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://localhost/',
      },
    },
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    include: ['src/**/*.vitest.{js,jsx,ts,tsx}'],
    // Make the Supabase/PostHog clients consider themselves configured so the
    // gated data hooks exercise their real (enabled) code paths. No network is
    // hit — the fetchers are injected/mocked per test.
    env: {
      VITE_SUPABASE_URL: 'http://localhost:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    },
  },
})
