// @ts-check
// Single Supabase browser client, shared by auth + cloud favorites (and, later,
// eBay comps / the full migration — see issues #6, #98). Reuse this instance;
// do not call createClient elsewhere.
//
// Reads VITE_SUPABASE_URL + VITE_SUPABASE_PUBLISHABLE_KEY (the new-model
// publishable key, `sb_publishable_…`). The publishable key is safe to ship in
// a public bundle because every table has row-level security. The secret key
// (`sb_secret_…`) must NEVER reach the browser — it lives only in backend /
// Actions env.
//
// When the env vars are absent (e.g. a local dev checkout without an
// `.env.local`, or a CI build that hasn't wired the secrets), `supabase` is
// null and `isSupabaseConfigured` is false. Callers must treat auth + cloud
// favorites as unavailable and fall back to the anonymous cookie cache, so the
// static site keeps working without a backend.

import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const isSupabaseConfigured = Boolean(url && publishableKey)

// Gate on `url && publishableKey` (not the derived isSupabaseConfigured) so
// createClient sees `string`, not `string | undefined`.
export const supabase = url && publishableKey
  ? createClient(url, publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Must be true so the client picks up the token Supabase appends to the
        // email confirmation / password-reset redirect URL.
        detectSessionInUrl: true,
      },
    })
  : null
