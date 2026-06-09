import { defineConfig, devices } from '@playwright/test'

// Dedicated config for the usability benchmark. Runs serially in a single worker
// so per-objective results accumulate into one scored report.
export default defineConfig({
  testDir: './tests/usability',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // A healthy benchmark run takes ~2 minutes; bound the whole run so a hung
  // app load can't hold the CI job for hours (mirrors playwright.config.js).
  globalTimeout: process.env.CI ? 10 * 60_000 : 0,
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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
