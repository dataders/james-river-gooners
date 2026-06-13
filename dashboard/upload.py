"""Upload the built admin dashboard HTML to a PRIVATE Supabase Storage bucket.

The bucket (`admin-dashboard`, created in supabase/migrations/0020_admin_dashboard.sql)
is private with an RLS policy that only lets the owner's user id read it. The
build workflow runs this with the service (secret) key, which bypasses RLS; the
SPA's /admin route downloads the same object with the signed-in owner's session.

The object is written to a stable path (`latest.html`) so the frontend always
fetches the freshest build.

Usage:
    SUPABASE_URL=... SUPABASE_SECRET_KEY=sb_secret_... \
        uv run --with requests python upload.py dist/admin.html
"""

from __future__ import annotations

import os
import sys
import time

import requests

BUCKET = os.environ.get("ADMIN_DASHBOARD_BUCKET", "admin-dashboard")
OBJECT_PATH = os.environ.get("ADMIN_DASHBOARD_OBJECT", "latest.html")

# Retry transient failures (network errors, rate limits, 5xx — including
# Supabase Storage's 544 "DatabaseTimeout") with exponential backoff
# (2s, 4s, 8s, 16s) — the same convention used elsewhere in the project
# (scraper/supabase_enrichment.py, sold_history.py).
DEFAULT_MAX_RETRIES = 4


def _is_transient(status_code: int) -> bool:
    return status_code == 429 or status_code >= 500


def _upload_with_retry(endpoint, headers, body, max_retries=DEFAULT_MAX_RETRIES, sleep=None):
    """POST the object, retrying transient failures; exit(1) on permanent failure."""
    sleep = sleep or time.sleep  # resolved at call time so tests can patch time.sleep
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(endpoint, headers=headers, data=body, timeout=60)
        except requests.exceptions.RequestException as exc:
            if attempt >= max_retries:
                sys.exit(f"Upload failed after {attempt + 1} attempt(s): {exc}")
            delay = 2 ** (attempt + 1)
            print(f"Upload attempt {attempt + 1} errored ({exc}); retrying in {delay}s…")
            sleep(delay)
            continue

        if resp.status_code in (200, 201):
            return
        if _is_transient(resp.status_code) and attempt < max_retries:
            delay = 2 ** (attempt + 1)
            print(
                f"Upload attempt {attempt + 1} got {resp.status_code} "
                f"({resp.text[:120]}); retrying in {delay}s…"
            )
            sleep(delay)
            continue
        sys.exit(f"Upload failed ({resp.status_code}): {resp.text[:300]}")


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "dist/admin.html"
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SECRET_KEY are required to upload")

    with open(src, "rb") as fh:
        body = fh.read()

    endpoint = f"{url.rstrip('/')}/storage/v1/object/{BUCKET}/{OBJECT_PATH}"
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "text/html; charset=utf-8",
        "x-upsert": "true",
        "cache-control": "no-cache",
    }
    _upload_with_retry(endpoint, headers, body)
    print(f"Uploaded {len(body):,} bytes → {BUCKET}/{OBJECT_PATH}")


if __name__ == "__main__":
    main()
