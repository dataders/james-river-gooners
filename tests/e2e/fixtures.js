// Custom Playwright `test` that auto-installs the Supabase network mock on the
// browser context before any navigation — so every spec runs against the local
// fixture (./_mock) instead of the production database. Specs import { test,
// expect } from here instead of '@playwright/test'; nothing else changes.
import { test as base, expect } from '@playwright/test'
import { installSupabaseMock } from './_mock/supabaseMock.js'

export const test = base.extend({
  // Second arg is Playwright's fixture-`use` callback; named `run` so eslint's
  // react-hooks/rules-of-hooks doesn't mistake it for React's `use` hook.
  context: async ({ context }, run) => {
    await installSupabaseMock(context)
    await run(context)
  },
})

export { expect }
