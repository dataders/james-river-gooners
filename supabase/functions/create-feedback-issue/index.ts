// create-feedback-issue Edge Function
//
// POST body: { message: string, email?: string }
// Returns:   { issue_url: string }
//
// Creates a GitHub issue from the user's feedback synchronously and logs the
// submission to user_feedback. No JWT required (verify_jwt: false in deploy).
//
// Required secret:
//   GITHUB_FEEDBACK_TOKEN — fine-grained PAT with issues:write on this repo
// Auto-injected by Supabase:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const GITHUB_TOKEN = Deno.env.get('GITHUB_FEEDBACK_TOKEN') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const REPO = 'dataders/james-river-gooners'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: { message?: string; email?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const message = body.message?.trim() ?? ''
  const email = body.email?.trim() ?? ''

  if (!message || message.length > 2000) {
    return json({ error: 'message must be 1–2000 characters' }, 400)
  }

  if (!GITHUB_TOKEN) {
    return json({ error: 'GitHub token not configured' }, 500)
  }

  const issueBody = email ? `${message}\n\n---\n*Submitted by: ${email}*` : message

  const ghRes = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'james-river-gooners-feedback',
    },
    body: JSON.stringify({ title: 'User feedback', body: issueBody, labels: ['feedback'] }),
  })

  if (!ghRes.ok) {
    console.error('GitHub API error:', ghRes.status, await ghRes.text())
    return json({ error: 'Failed to create GitHub issue' }, 502)
  }

  const issue = await ghRes.json() as { html_url: string }
  const issueUrl = issue.html_url

  // Log to user_feedback (non-fatal if Supabase is unconfigured)
  if (SUPABASE_URL && SUPABASE_SRK) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/user_feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SRK,
          'Authorization': `Bearer ${SUPABASE_SRK}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          message,
          user_email: email || null,
          github_issue_url: issueUrl,
          processed_at: new Date().toISOString(),
        }),
      })
    } catch (e) {
      console.error('Failed to log feedback to Supabase:', e)
    }
  }

  return json({ issue_url: issueUrl })
})
