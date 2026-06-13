// Custom Playwright `test` for the usability benchmark that auto-installs the
// shared Supabase network mock (tests/e2e/_mock) on the browser context — so the
// benchmark runs against the deterministic local fixture instead of production
// Supabase, the same way the E2E suite does. Installing on `context` (not
// `page`) means context.newPage() in the share-deeplink objective is covered too.
import { test as base } from '@playwright/test'
import { installSupabaseMock } from '../e2e/_mock/supabaseMock.js'

export const test = base.extend({
  // Second arg is Playwright's fixture-`use` callback; named `run` so eslint's
  // react-hooks/rules-of-hooks doesn't mistake it for React's `use` hook.
  context: async ({ context }, run) => {
    await installSupabaseMock(context)
    await run(context)
  },
})
