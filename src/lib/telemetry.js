// @ts-check
// Single PostHog browser client for anonymous, privacy-friendly telemetry.
// Mirrors src/lib/supabase.js: reads a VITE_ env var, exports a maybe-null
// client plus an `isAnalyticsConfigured` flag so the static site still works
// with no telemetry wired (local dev / forks without the key) — the helpers
// below all no-op in that case.
//
// Privacy posture (deliberately non-obtrusive):
// - person_profiles: 'identified_only' — anonymous visitors are counted as
//   events under a random distinct_id but never get a stored person profile.
//   Only users we explicitly identify() (logged-in Supabase users, by their
//   user id) become identified people. So we see BOTH unauthenticated and
//   authenticated sessions, but anonymous ones stay anonymous.
// - persistence: 'localStorage' — no tracking cookies are set.
// - respect_dnt — honors the browser's "Do Not Track" signal.
// - autocapture + session recording are OFF; we send only the handful of
//   explicit events declared via captureEvent(), nothing that records clicks,
//   keystrokes, or screen content.
//
// VITE_POSTHOG_KEY  — PostHog project API key. Browser-safe to ship: it is a
//                     write-only ingestion key, not the personal/admin token.
// VITE_POSTHOG_HOST — optional ingestion host; defaults to PostHog US cloud.
//                     Set to https://eu.i.posthog.com for the EU cloud, or your
//                     own URL when self-hosting.

import posthog from 'posthog-js'

const key = import.meta.env.VITE_POSTHOG_KEY
const host = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'

export const isAnalyticsConfigured = Boolean(key)

let initialized = false

/**
 * Initialize PostHog once, on app boot. Safe to call when telemetry is not
 * configured (no-op) or more than once (idempotent).
 */
export function initAnalytics() {
  // Narrow on `key` (not the derived isAnalyticsConfigured) so posthog.init
  // sees a `string`, not `string | undefined`.
  if (!key || initialized) return
  if (typeof window === 'undefined') return

  posthog.init(key, {
    api_host: host,
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    respect_dnt: true,
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: true,
    disable_session_recording: true,
  })
  initialized = true
}

/**
 * Record an explicit product event, e.g. captureEvent('favorite_added').
 * @param {string} event
 * @param {Record<string, unknown>} [props]
 */
export function captureEvent(event, props) {
  if (!isAnalyticsConfigured) return
  posthog.capture(event, props)
}

/**
 * Tie subsequent events to a known user (the Supabase user id). Call on login.
 * @param {string} userId
 * @param {Record<string, unknown>} [props]
 */
export function identifyUser(userId, props) {
  if (!isAnalyticsConfigured || !userId) return
  posthog.identify(userId, props)
}

/**
 * Drop the identified user and start a fresh anonymous distinct_id. Call on
 * logout so the next session isn't attributed to the previous user.
 */
export function resetAnalytics() {
  if (!isAnalyticsConfigured) return
  posthog.reset()
}
