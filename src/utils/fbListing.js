// Call the facebook-listing Edge Function with an item object.
// Returns the generated listing or { error: string } on failure.
export async function generateFbListing(item, client) {
  if (!client) return { error: 'Not configured' }
  const { data: { session } } = await client.auth.getSession()
  if (!session) return { error: 'Not signed in' }
  const { data, error } = await client.functions.invoke('facebook-listing', { body: item })
  if (error) {
    if (error.context?.json) {
      try {
        const body = await error.context.json()
        if (body?.error) return { error: body.error }
      } catch { /* fall through */ }
    }
    return { error: error.message }
  }
  return data ?? { error: 'Empty response' }
}
