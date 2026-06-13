import { defineConfig, devices } from '@playwright/test'

// Dedicated config for the usability benchmark. Runs serially in a single worker
// so per-objective results accumulate into one scored report.
export default defineConfig({
  testDir: './tests/usability',
  // Data is served from the in-process Supabase mock (tests/usability/fixtures.js
  // → tests/e2e/_mock), so loads are fast and deterministic — no cold-DB window
  // to budget for. Still serial/single-worker so per-objective results
  // accumulate into one scored report.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
    permissions: ['clipboard-read', 'clipboard-write'],
    storageState: {
      cookies: [],
      origins: [{
        origin: 'http://localhost:5173',
        localStorage: [{ name: 'gooners-tutorial-seen', value: '1' }],
      }],
    },
  },
  projects: [
    // userAgent after the device spread (tags requests for Supabase log
    // attribution; distinct from the E2E suite's `gooners-e2e`).
    { name: 'chromium', use: { ...devices['Desktop Chrome'], userAgent: 'gooners-usability' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // Pin a dead-end Supabase URL (defence-in-depth behind the request mock);
    // CI no longer needs the real VITE_SUPABASE_* secrets for this job.
    env: {
      VITE_SUPABASE_URL: 'https://e2e.supabase.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_dummy',
    },
  },
})
