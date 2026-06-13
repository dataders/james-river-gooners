import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  // Data is served from the in-process Supabase mock (tests/e2e/_mock), so the
  // grid loads in milliseconds and counts are deterministic — none of the
  // free-tier-contention band-aids this config used to carry are needed. The
  // budget is comfortable for a fully-parallel run on a controlled fixture.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Deterministic mock → no flaky cold-DB loads to paper over. One retry in CI
  // stays as cheap insurance against the occasional rendering/timing blip.
  retries: process.env.CI ? 1 : 0,
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
    // userAgent after the device spread so it overrides Desktop Chrome's UA:
    // tags every request (incl. Supabase PostgREST) as the E2E suite so the
    // Supabase API logs can attribute compute to tests vs the web app vs the
    // scraper pipelines (`gooners-scraper/<job>`).
    { name: 'chromium', use: { ...devices['Desktop Chrome'], userAgent: 'gooners-e2e' } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    // Pin a dead-end Supabase URL so the app's Supabase code path is active
    // (isSupabaseConfigured === true) but the base host resolves nowhere — a
    // second layer of defence behind the path-based request mock. CI no longer
    // needs to pass the real VITE_SUPABASE_* secrets to the test job.
    env: {
      VITE_SUPABASE_URL: 'https://e2e.supabase.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e_dummy',
    },
  },
})
