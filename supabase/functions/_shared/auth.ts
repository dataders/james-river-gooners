// Shared JWT gate for members-only edge functions.
// Returns the authenticated user, or a ready-to-send 401 Response.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
}

// Verify the Bearer token belongs to an authenticated user.
// Returns { user, supabase, token } on success or { response } (a 401) on failure.
export async function requireUser(req: Request) {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { response: jsonResponse({ error: 'Unauthorized' }, 401) }
  }
  const supabase = serviceClient()
  const token = authHeader.replace('Bearer ', '')
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    return { response: jsonResponse({ error: 'Unauthorized' }, 401) }
  }
  return { user, supabase, token }
}
