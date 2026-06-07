# Morning To-Do Email

An automated daily email with your **calendar agenda for the day** plus the
**actionable unread mail** from your Gmail inbox. Runs every morning at ~7:00 AM
US Eastern via GitHub Actions (`.github/workflows/morning-todo.yml`).

## What it sends

- **📅 Today's schedule** — every event on your calendar today, with times,
  locations, and parsed Google Meet / Zoom links and call-in numbers.
- **✉️ Needs a reply / attention** — unread *primary-category* mail from real
  people (newsletters, promotions, and social notifications are filtered out).
- **🗂️ Pipeline count** — how many new "New application" recruiting emails are
  waiting to review.

Each data source is isolated, so a transient Calendar or Gmail API hiccup still
sends an email with whatever it could gather.

## One-time setup

### 1. Create a Google OAuth client

1. Go to the [Google Cloud Console](https://console.cloud.google.com/), create
   (or pick) a project.
2. Enable the **Google Calendar API** and the **Gmail API**.
3. Under **APIs & Services → Credentials**, create an **OAuth client ID** of
   type **Desktop app**. Download the client-secret JSON.
4. On the **OAuth consent screen**, add your own Google account as a **Test
   user** (so the unverified app can issue you a long-lived token).

### 2. Mint a refresh token (run locally, once)

```bash
cd automation/morning_todo
uv run --with google-auth-oauthlib python get_refresh_token.py /path/to/client_secret.json
```

A browser opens; approve the Calendar + Gmail scopes. The script prints three
values.

### 3. Add the secrets to GitHub

Repo **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | from step 2 |
| `GOOGLE_CLIENT_SECRET` | from step 2 |
| `GOOGLE_REFRESH_TOKEN` | from step 2 |
| `MORNING_TODO_TO` | *(optional)* recipient address; defaults to your own Gmail |

That's it — the cron is already scheduled. To verify it now, run the workflow
manually: **Actions → Morning To-Do Email → Run workflow**, optionally ticking
**dry_run** to see the email printed in the log without sending.

## Configuration

All optional, set as `env:` in the workflow or repo secrets:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MORNING_TODO_TO` | token's own address | Recipient email |
| `MORNING_TODO_TZ` | `America/New_York` | Your timezone (IANA name) |
| `MORNING_TODO_CALENDAR` | `primary` | Calendar id to read |
| `MORNING_TODO_SEND_HOUR` | `7` | Local hour the daily email should go out |
| `MORNING_TODO_FORCE` | `0` | `1` ignores the send-hour guard |
| `MORNING_TODO_DRY_RUN` | `0` | `1` prints instead of sending |

## How the 7 AM timing works

GitHub Actions cron is UTC-only and has no daylight-saving awareness, so the
workflow fires at **both** 11:00 and 12:00 UTC. The run whose *local* hour isn't
`MORNING_TODO_SEND_HOUR` (7) quietly no-ops, so exactly one email is sent at
7 AM ET whether it's summer (EDT) or winter (EST).

## Local test

```bash
cd automation/morning_todo
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... \
MORNING_TODO_DRY_RUN=1 \
uv run --with google-api-python-client --with google-auth python main.py
```
