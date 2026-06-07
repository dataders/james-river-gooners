#!/usr/bin/env python3
"""One-time helper: mint the Google OAuth refresh token for the morning to-do job.

Run this ONCE on your own machine (not in CI). It opens a browser, you approve
the calendar + gmail scopes, and it prints a refresh token you paste into the
GitHub Actions secret GOOGLE_REFRESH_TOKEN. The token is long-lived, so you only
do this again if you revoke access or change scopes.

Prereqs:
  1. In Google Cloud Console create an OAuth 2.0 Client ID of type "Desktop app".
  2. Download its client secret JSON.
  3. Enable the Google Calendar API and Gmail API for that project.

Usage:
  uv run --with google-auth-oauthlib python get_refresh_token.py /path/to/client_secret.json
"""

import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: python get_refresh_token.py /path/to/client_secret.json", file=sys.stderr)
        return 2

    client_secret = sys.argv[1]
    # access_type=offline + prompt=consent guarantees a refresh_token comes back.
    flow = InstalledAppFlow.from_client_secrets_file(client_secret, scopes=SCOPES)
    creds = flow.run_local_server(
        port=0,
        access_type="offline",
        prompt="consent",
    )

    print("\n" + "=" * 60)
    print("SUCCESS. Add these to your GitHub repo secrets:\n")
    print(f"  GOOGLE_CLIENT_ID      = {creds.client_id}")
    print(f"  GOOGLE_CLIENT_SECRET  = {creds.client_secret}")
    print(f"  GOOGLE_REFRESH_TOKEN  = {creds.refresh_token}")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
