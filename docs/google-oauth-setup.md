# Google OAuth Setup for James River Gooners

Enables "Sign in with Google" via Supabase. Total time: ~15 min.

## What's CLI vs browser

| Step | Where |
|---|---|
| Install tools | script |
| `gcloud auth login` | opens browser once (expected) |
| Select / create GCP project | CLI |
| Enable Google Identity API | CLI |
| **Configure OAuth consent screen** | **browser (~5 min)** |
| **Create OAuth 2.0 credentials** | **browser (~2 min)** |
| Configure Supabase auth provider | Claude via MCP (just paste the credentials) |

There is no stable `gcloud` command for creating OAuth 2.0 Web Application credentials or configuring the consent screen — Google's own docs point to the Console for both. Two browser steps is the minimum.

---

## Step 1 — Install tools

Run the setup script (requires `bash`; detects macOS vs Linux and skips anything already installed):

```bash
bash scripts/setup-google-oauth.sh
```

This installs:
- [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install)
- [Supabase CLI](https://supabase.com/docs/guides/cli/getting-started) *(optional — Claude can configure Supabase directly via MCP)*
- [GitHub CLI (`gh`)](https://cli.github.com/) *(likely already present)*

---

## Step 2 — Authenticate and pick a project (CLI)

```bash
# Log in (opens browser once for the OAuth consent, then stores credentials locally)
gcloud auth login

# List your existing projects
gcloud projects list

# Use an existing project, or create a new one
gcloud config set project YOUR_PROJECT_ID

# --- OR create a fresh project ---
gcloud projects create james-river-gooners --name="James River Gooners"
gcloud config set project james-river-gooners
```

---

## Step 3 — Enable the Google Identity API (CLI)

```bash
gcloud services enable oauth2.googleapis.com
gcloud services enable identitytoolkit.googleapis.com  # optional but good practice
```

Verify:

```bash
gcloud services list --enabled | grep oauth2
```

---

## Step 4 — Configure the OAuth consent screen (BROWSER, ~5 min)

Open: **<https://console.cloud.google.com/apis/credentials/consent>**

1. Choose **External** (works for any Google account; Internal is Google Workspace–only)
2. Fill in:
   - **App name:** James River Gooners
   - **User support email:** your email
   - **Developer contact:** your email
3. **Scopes** — click "Add or Remove Scopes", add:
   - `openid`
   - `email`
   - `profile`
4. **Test users** — add your own email so you can test before publishing
5. Save and continue through the summary; no need to submit for verification for a private app

---

## Step 5 — Create OAuth 2.0 credentials (BROWSER, ~2 min)

Open: **<https://console.cloud.google.com/apis/credentials>**

1. Click **+ Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Name: `James River Gooners (Supabase)`
4. Under **Authorized redirect URIs**, add:
   ```
   https://<your-supabase-project-ref>.supabase.co/auth/v1/callback
   ```
   Your project ref is the subdomain in your Supabase URL (e.g. `abcdefghijklmnop`).
5. Click **Create**
6. Copy the **Client ID** and **Client Secret** — you'll need both in the next step

> **Where to find your Supabase project ref:** `VITE_SUPABASE_URL` in `.env.local` —
> it's the part between `https://` and `.supabase.co`.

---

## Step 6 — Configure Supabase (hand credentials to Claude)

Once you have the Client ID and Secret from Step 5, paste them into the chat:

> "Here are my Google OAuth credentials — Client ID: `…` / Client Secret: `…`"

Claude will configure the Supabase auth provider directly via the MCP server. No dashboard login needed on your end.

If you prefer to do it yourself via the CLI:

```bash
# Requires SUPABASE_ACCESS_TOKEN env var (generate at https://supabase.com/dashboard/account/tokens)
supabase --experimental \
  projects api-keys \
  --project-ref YOUR_PROJECT_REF

# Then update the auth config via the Management API
curl -X PATCH "https://api.supabase.com/v1/projects/YOUR_PROJECT_REF/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "external_google_enabled": true,
    "external_google_client_id": "YOUR_CLIENT_ID",
    "external_google_secret": "YOUR_CLIENT_SECRET"
  }'
```

---

## Step 7 — Test

1. Run the dev server: `npm run dev`
2. Open <http://localhost:5173>, click the user icon → "Sign in with Google"
3. Complete the Google OAuth flow — you should land back on the app, logged in

If the button is missing, confirm `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are set in `.env.local`.

---

## Cost

Zero. "Sign in with Google" uses standard OAuth 2.0 which is part of Google's free Identity Platform tier. No per-user charges, no MAU limits, no billing account required beyond having a Google account. The only thing that costs money is Google's *advanced* Identity Platform features (phone auth, MFA enforcement) — basic OAuth sign-in is always free.
