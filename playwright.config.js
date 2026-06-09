import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // The grid loads ~6.5K lots from a slow free-tier DB and each test's
  // beforeEach waits for the full set, so the per-test budget is generous.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // Cap CI parallelism: every worker loads the full dataset at once, and too
  // many simultaneous loads saturate free-tier Supabase's connections and stall
  // the load past the timeout. Two workers keeps contention low while still
  // parallelising vs serial.
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Fail fast in CI when the environment is wedged: if the backend is down,
  // every test fails the same way in beforeEach — stop after 10 definitive
  // failures (flaky-then-pass doesn't count) instead of grinding all 116
  // tests through the 90s timeout twice, which once held the job for 2h42m.
  maxFailures: process.env.CI ? 10 : 0,
  // A healthy CI run takes ~6 minutes; anything past 15 means the environment
  // is hung, not slow. Aborting here still writes the report/artifact, unlike
  // the workflow-level timeout-minutes backstop that kills the job outright.
  globalTimeout: process.env.CI ? 15 * 60_000 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    storageState: {
      cookies: [],
      origins: [{
        origin: 'http://localhost:5173',
        localStorage: [{ name: 'gooners-tutorial-seen', value: '1' }],
      }],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
