// @ts-nocheck
// cannon-proxy Edge Function caller with an injectable Supabase client for testability.
// No Vite / browser dependencies.

// Call a cannon-proxy action.  Returns the response data object, or
// { error: <message> } on any failure.  `client` must be a Supabase client
// instance (null/undefined is treated as "not configured").
export async function callProxy(action, params = {}, client) {
  if (!client) return { error: 'Not configured' }
  const { data: { session } } = await client.auth.getSession()
  if (!session) return { error: 'Not signed in' }
  const { data, error } = await client.functions.invoke('cannon-proxy', {
    body: { action, ...params },
  })
  if (error) {
    // FunctionsHttpError carries the raw Response in .context — extract our
    // structured { error } body from it so the user sees the real reason.
    if (error.context?.json) {
      try {
        const body = await error.context.json()
        if (body?.error) return { error: body.error }
      } catch { /* fall through */ }
    }
    return { error: error.message }
  }
  return data ?? {}
}