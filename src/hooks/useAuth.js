// @ts-check
// Email/password auth state for the SPA (issue #92).
//
// Exposes the current Supabase user/session plus the sign-up / sign-in /
// sign-out / password-reset actions. Subscribes to onAuthStateChange so the
// session stays in sync across tabs and token refreshes, and survives reloads
// (the client persists the session to localStorage).
//
// When Supabase is not configured (`supabase === null`), this degrades to a
// permanently-signed-out state and the actions return a friendly error, so the
// rest of the app keeps working off the anonymous cookie cache.

import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import { identifyUser, resetAnalytics } from '../lib/telemetry'

/** @typedef {import('@supabase/supabase-js').Session} Session */

const NOT_CONFIGURED = { error: 'Sign-in is not available right now.' }

export function useAuth() {
  // `loading` is the initial session lookup; null user once resolved = signed out.
  const [session, setSession] = useState(/** @type {Session | null} */ (null))
  const [loading, setLoading] = useState(isSupabaseConfigured)

  // Tie anonymous telemetry to the Supabase user on login, and drop the
  // identity on logout so the next session isn't attributed to the prior user.
  // `identifiedId` tracks who we've told PostHog about, so we only reset on a
  // real sign-out (not on every anonymous page load).
  const identifiedId = useRef(/** @type {string | null} */ (null))
  const userId = session?.user?.id ?? null
  useEffect(() => {
    if (userId) {
      identifyUser(userId)
      identifiedId.current = userId
    } else if (identifiedId.current) {
      resetAnalytics()
      identifiedId.current = null
    }
  }, [userId])

  useEffect(() => {
    if (!supabase) return

    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session ?? null)
      setLoading(false)
    })

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null)
      setLoading(false)
    })

    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  const signUp = useCallback(/** @param {string} email @param {string} password */ async (email, password) => {
    if (!supabase) return NOT_CONFIGURED
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) return { error: error.message }
    // When email confirmation is on, Supabase returns a user but no session;
    // the caller shows a "check your email" message in that case.
    return { needsConfirmation: !data.session }
  }, [])

  const signIn = useCallback(/** @param {string} email @param {string} password */ async (email, password) => {
    if (!supabase) return NOT_CONFIGURED
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) return { error: error.message }
    return {}
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) return NOT_CONFIGURED
    const { error } = await supabase.auth.signOut()
    if (error) return { error: error.message }
    return {}
  }, [])

  const resetPassword = useCallback(/** @param {string} email */ async (email) => {
    if (!supabase) return NOT_CONFIGURED
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    })
    if (error) return { error: error.message }
    return {}
  }, [])

  const changePassword = useCallback(/** @param {string} password */ async (password) => {
    if (!supabase) return NOT_CONFIGURED
    const { error } = await supabase.auth.updateUser({ password })
    if (error) return { error: error.message }
    return {}
  }, [])

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return NOT_CONFIGURED
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })
    if (error) return { error: error.message }
    return {}
  }, [])

  return {
    available: isSupabaseConfigured,
    user: session?.user ?? null,
    session,
    loading,
    signUp,
    signIn,
    signOut,
    resetPassword,
    changePassword,
    signInWithGoogle,
  }
}
