// Owner-only admin monitoring dashboard (mounted at /admin via src/admin-entry.jsx).
//
// The dashboard HTML is built hourly from the dbt marts in MotherDuck and
// uploaded to a PRIVATE Supabase Storage bucket (`admin-dashboard/latest.html`,
// migration 0020). Only the owner's email can read it (Storage RLS) — the data
// never ships in the public bundle. This component:
//   1. resolves the Supabase session (a local telemetry-free hook, so the admin
//      bundle stays lean),
//   2. shows a login gate when signed out / a "not authorized" notice for any
//      other user,
//   3. for the owner, downloads the object with the authenticated client and
//      renders it in a full-viewport iframe (blob URL → the prefab CDN renderer
//      runs in an isolated document).
//
// The Storage RLS policy is the real gate; the email check here is only UX
// (a non-owner's download returns nothing regardless).

import { useEffect, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase, isSupabaseConfigured } from '../lib/supabase'

const OWNER_EMAIL = 'swanson.anders@gmail.com'
const BUCKET = 'admin-dashboard'
const OBJECT = 'latest.html'

// Minimal Supabase-only session hook for the admin route. Deliberately does NOT
// reuse the app's useAuth — that pulls in the telemetry module (and the ~60 KB
// posthog-js bundle), which this owner-only page has no use for. Keeping the
// admin bundle lean is a real load-time win on the sign-in gate.
function useOwnerSession() {
  const [session, setSession] = useState(/** @type {any} */ (null))
  const [loading, setLoading] = useState(() => Boolean(supabase))

  useEffect(() => {
    if (!supabase) return  // no setState here → effect-safe
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (active) { setSession(data.session ?? null); setLoading(false) }
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null); setLoading(false)
    })
    return () => { active = false; sub.subscription.unsubscribe() }
  }, [])

  const signIn = useCallback(async (email, password) => {
    if (!supabase) return { error: 'Sign-in is not available right now.' }
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return error ? { error: error.message } : {}
  }, [])

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return
    // Return to /admin after the OAuth round-trip, not the main site root.
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } })
  }, [])

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut()
  }, [])

  return { user: session?.user ?? null, loading, signIn, signInWithGoogle, signOut }
}

const shell = {
  minHeight: '100vh',
  background: '#0b1220',
  color: '#e2e8f0',
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  display: 'flex',
  flexDirection: 'column',
}

function Centered({ children }) {
  return (
    <div style={{ ...shell, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 380 }}>{children}</div>
    </div>
  )
}

function LoginGate({ auth }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const res = await auth.signIn(email, password)
    setBusy(false)
    if (res?.error) setError(res.error)
  }

  return (
    <Centered>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Gooners · Admin</h1>
      <p style={{ color: '#94a3b8', margin: '0 0 20px', fontSize: 14 }}>
        Sign in to view the monitoring dashboard.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input
          type="email" placeholder="Email" value={email} autoComplete="email"
          onChange={(e) => setEmail(e.target.value)} style={inputStyle} required
        />
        <input
          type="password" placeholder="Password" value={password} autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)} style={inputStyle} required
        />
        {error && <div style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={busy} style={primaryBtn}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      {auth.signInWithGoogle && (
        <button onClick={() => auth.signInWithGoogle()} style={{ ...ghostBtn, marginTop: 10 }}>
          Continue with Google
        </button>
      )}
      <a href="/" style={{ display: 'block', marginTop: 18, color: '#60a5fa', fontSize: 13, textAlign: 'center' }}>
        ← Back to the site
      </a>
    </Centered>
  )
}

const inputStyle = {
  padding: '10px 12px', borderRadius: 8, border: '1px solid #334155',
  background: '#111827', color: '#e2e8f0', fontSize: 14,
}
const primaryBtn = {
  padding: '10px 12px', borderRadius: 8, border: 'none', cursor: 'pointer',
  background: '#ef4444', color: '#fff', fontSize: 14, fontWeight: 600,
}
const ghostBtn = {
  padding: '10px 12px', borderRadius: 8, border: '1px solid #334155', cursor: 'pointer',
  background: 'transparent', color: '#e2e8f0', fontSize: 14, width: '100%',
}

export function AdminDashboard() {
  const auth = useOwnerSession()
  const isOwner = auth.user?.email === OWNER_EMAIL

  // Download the private HTML and hand back a blob URL. The Storage RLS policy
  // (migration 0020) is the real gate — a non-owner's download throws here, so
  // the query is also disabled for them. react-query owns the async/loading
  // state (matching the rest of the app's data hooks).
  const { data: src, status, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-dashboard-html'],
    enabled: isOwner && Boolean(supabase),
    staleTime: 5 * 60 * 1000,
    gcTime: 0,
    retry: false,
    queryFn: async () => {
      const get = (path) => supabase.storage.from(BUCKET).download(path)
      // Cache-bust first; fall back to the plain path if the query suffix 404s.
      let res = await get(`${OBJECT}?t=${Date.now()}`)
      if (res.error || !res.data) res = await get(OBJECT)
      if (res.error || !res.data) throw new Error(res.error?.message || 'Dashboard not available yet.')
      return URL.createObjectURL(res.data)
    },
  })

  // Revoke the blob URL on unmount / when it changes (no setState → effect-safe).
  useEffect(() => () => { if (src) URL.revokeObjectURL(src) }, [src])

  const refresh = () => refetch()

  if (!isSupabaseConfigured) {
    return (
      <Centered>
        <h1 style={{ fontSize: 20 }}>Admin dashboard unavailable</h1>
        <p style={{ color: '#94a3b8', fontSize: 14 }}>Supabase is not configured for this build.</p>
      </Centered>
    )
  }

  if (auth.loading) {
    return <Centered><p style={{ color: '#94a3b8' }}>Checking session…</p></Centered>
  }

  if (!auth.user) {
    return <LoginGate auth={auth} />
  }

  if (!isOwner) {
    return (
      <Centered>
        <h1 style={{ fontSize: 20, margin: '0 0 6px' }}>Not authorized</h1>
        <p style={{ color: '#94a3b8', fontSize: 14 }}>
          Signed in as <strong>{auth.user.email}</strong>. This dashboard is owner-only.
        </p>
        <button onClick={() => auth.signOut()} style={{ ...ghostBtn, marginTop: 14 }}>Sign out</button>
        <a href="/" style={{ display: 'block', marginTop: 14, color: '#60a5fa', fontSize: 13, textAlign: 'center' }}>
          ← Back to the site
        </a>
      </Centered>
    )
  }

  return (
    <div style={shell}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', borderBottom: '1px solid #1e293b', background: '#0b1220',
        flex: '0 0 auto',
      }}>
        <strong style={{ fontSize: 14 }}>Gooners · Admin</strong>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}>
          <button onClick={refresh} disabled={isFetching} style={{ ...ghostBtn, padding: '5px 10px', width: 'auto' }}>
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          <span style={{ color: '#64748b' }}>{auth.user.email}</span>
          <button onClick={() => auth.signOut()} style={{ ...ghostBtn, padding: '5px 10px', width: 'auto' }}>
            Sign out
          </button>
        </div>
      </header>

      <div style={{ flex: '1 1 auto', position: 'relative', background: '#fff' }}>
        {!src && status !== 'error' && (
          <div style={overlayStyle}>Loading dashboard…</div>
        )}
        {status === 'error' && (
          <div style={overlayStyle}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ margin: '0 0 10px' }}>Couldn’t load the dashboard.</p>
              <p style={{ color: '#94a3b8', fontSize: 13, margin: '0 0 14px', maxWidth: 360 }}>
                {error?.message || 'It may not have been built yet — the refresh runs hourly.'}
              </p>
              <button onClick={refresh} style={primaryBtn}>Retry</button>
            </div>
          </div>
        )}
        {src && (
          <iframe
            title="Gooners admin dashboard"
            src={src}
            style={{ border: 'none', width: '100%', height: '100%', display: 'block' }}
          />
        )}
      </div>
    </div>
  )
}

const overlayStyle = {
  position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
  justifyContent: 'center', background: '#0b1220', color: '#e2e8f0', zIndex: 1,
}
