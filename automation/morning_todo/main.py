#!/usr/bin/env python3
"""Morning to-do email.

Reads today's Google Calendar agenda plus the actionable unread mail from
Gmail, composes a tidy to-do list, and emails it to the user every morning.

Designed to run unattended from a GitHub Actions cron (see
`.github/workflows/morning-todo.yml`). All access is via a single Google OAuth
refresh token with three read/send scopes:

  - https://www.googleapis.com/auth/calendar.readonly
  - https://www.googleapis.com/auth/gmail.readonly
  - https://www.googleapis.com/auth/gmail.send

Configuration (environment variables, supplied as GitHub Actions secrets):

  GOOGLE_CLIENT_ID       OAuth client id      (required)
  GOOGLE_CLIENT_SECRET   OAuth client secret  (required)
  GOOGLE_REFRESH_TOKEN   OAuth refresh token  (required; see get_refresh_token.py)
  MORNING_TODO_TO        recipient address    (optional; defaults to the token's
                                               own Gmail address)
  MORNING_TODO_TZ        IANA tz name         (optional; default America/New_York)
  MORNING_TODO_CALENDAR  calendar id          (optional; default "primary")
  MORNING_TODO_SEND_HOUR local hour to send   (optional; default 7). The cron
                                               fires at both 11:00 and 12:00 UTC
                                               to straddle US daylight saving;
                                               the run whose *local* hour isn't
                                               this value quietly no-ops, so
                                               exactly one email goes out at ~7am
                                               ET year-round.
  MORNING_TODO_FORCE     "1" ignores the hour guard (set on manual dispatch)
  MORNING_TODO_DRY_RUN   "1" prints to stdout instead of sending the email

The script is deliberately defensive: a failure pulling one source (calendar or
gmail) still sends an email with whatever it did gather, so a transient API
hiccup never leaves you with a silent morning.
"""

from __future__ import annotations

import base64
import os
import re
import sys
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from html import escape
from zoneinfo import ZoneInfo

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]

TOKEN_URI = "https://oauth2.googleapis.com/token"

# Senders/domains whose mail is bulk noise and never a personal to-do. Gmail's
# category filter (below) catches most marketing; this is a belt-and-suspenders
# denylist for the "needs attention" bucket.
BULK_SENDER_HINTS = (
    "no-reply",
    "noreply",
    "newsletter",
    "notifications@",
    "donotreply",
    "mailer-daemon",
)


def _env(name: str, default: str | None = None, required: bool = False) -> str | None:
    val = os.environ.get(name, default)
    if required and not val:
        print(f"ERROR: required environment variable {name} is not set", file=sys.stderr)
        sys.exit(1)
    return val


def build_credentials() -> Credentials:
    """Construct OAuth credentials from a long-lived refresh token.

    No on-disk token cache is needed: the refresh token plus the client
    id/secret is enough for google-auth to mint a fresh access token on demand.
    """
    return Credentials(
        token=None,
        refresh_token=_env("GOOGLE_REFRESH_TOKEN", required=True),
        client_id=_env("GOOGLE_CLIENT_ID", required=True),
        client_secret=_env("GOOGLE_CLIENT_SECRET", required=True),
        token_uri=TOKEN_URI,
        scopes=SCOPES,
    )


# --------------------------------------------------------------------------- #
# Calendar
# --------------------------------------------------------------------------- #

_MEET_RE = re.compile(r"https://meet\.google\.com/[a-z0-9\-]+", re.I)
_ZOOM_RE = re.compile(r"https://[a-z0-9.]*zoom\.us/j/\S+", re.I)
_PHONE_RE = re.compile(r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")


def _event_time_label(ev: dict, tz: ZoneInfo) -> str:
    start = ev.get("start", {})
    if "date" in start:  # all-day event
        return "All day"
    dt = datetime.fromisoformat(start["dateTime"]).astimezone(tz)
    # e.g. "9:00 AM" with no leading zero on the hour
    return dt.strftime("%-I:%M %p")


def _event_sort_key(ev: dict) -> str:
    start = ev.get("start", {})
    return start.get("dateTime") or start.get("date") or ""


def fetch_today_events(creds: Credentials, calendar_id: str, tz: ZoneInfo) -> list[dict]:
    """Return today's confirmed events (local day), earliest first."""
    service = build("calendar", "v3", credentials=creds, cache_discovery=False)
    now = datetime.now(tz)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)

    resp = (
        service.events()
        .list(
            calendarId=calendar_id,
            timeMin=day_start.isoformat(),
            timeMax=day_end.isoformat(),
            singleEvents=True,
            orderBy="startTime",
            maxResults=50,
        )
        .execute()
    )
    events = [e for e in resp.get("items", []) if e.get("status") != "cancelled"]
    events.sort(key=_event_sort_key)
    return events


def summarize_event(ev: dict, tz: ZoneInfo) -> dict:
    """Flatten a calendar event into the fields the email cares about."""
    summary = ev.get("summary", "(no title)")
    blob = " ".join(
        filter(None, [ev.get("description", ""), ev.get("location", ""), ev.get("conferenceUrl", "")])
    )
    meet = _MEET_RE.search(blob) or _MEET_RE.search(ev.get("conferenceUrl", "") or "")
    zoom = _ZOOM_RE.search(blob)
    phone = _PHONE_RE.search(blob)
    detail = None
    if meet:
        detail = f"Google Meet: {meet.group(0)}"
    elif zoom:
        detail = f"Zoom: {zoom.group(0)}"
    elif phone and "call" in summary.lower():
        detail = f"Call: {phone.group(0)}"
    elif ev.get("location"):
        detail = ev["location"]
    return {
        "time": _event_time_label(ev, tz),
        "title": summary,
        "detail": detail,
    }


# --------------------------------------------------------------------------- #
# Gmail
# --------------------------------------------------------------------------- #

def _header(msg: dict, name: str) -> str:
    for h in msg.get("payload", {}).get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _is_bulk(sender: str) -> bool:
    low = sender.lower()
    return any(hint in low for hint in BULK_SENDER_HINTS)


def _list_messages(service, query: str, cap: int = 25) -> list[dict]:
    resp = service.users().messages().list(userId="me", q=query, maxResults=cap).execute()
    out = []
    for ref in resp.get("messages", []):
        msg = (
            service.users()
            .messages()
            .get(userId="me", id=ref["id"], format="metadata",
                 metadataHeaders=["From", "Subject"])
            .execute()
        )
        out.append(msg)
    return out


def fetch_mail_buckets(creds: Credentials) -> dict:
    """Split the morning's unread mail into actionable buckets.

    - needs_attention: unread *primary*-category mail from a real person
      (newsletters, social, and promotions are filtered out by Gmail category
      plus a sender denylist).
    - applications: count of unread "New application" recruiting emails, which
      are a daily pipeline to review rather than individual to-dos.
    """
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)

    needs = []
    for msg in _list_messages(
        service, "is:unread in:inbox category:primary newer_than:3d"
    ):
        sender = _header(msg, "From")
        subject = _header(msg, "Subject") or "(no subject)"
        if _is_bulk(sender):
            continue
        # Trim "Name <email>" down to the display name when present.
        name = re.sub(r"\s*<.*?>$", "", sender).strip().strip('"') or sender
        needs.append({"from": name, "subject": subject})

    applications = _list_messages(
        service, "is:unread in:inbox subject:(New application) newer_than:7d", cap=50
    )

    return {
        "needs_attention": needs,
        "application_count": len(applications),
    }


def whoami(creds: Credentials) -> str:
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    return service.users().getProfile(userId="me").execute().get("emailAddress", "")


# --------------------------------------------------------------------------- #
# Compose + send
# --------------------------------------------------------------------------- #

def compose(events: list[dict], mail: dict, tz: ZoneInfo) -> tuple[str, str, str]:
    """Return (subject, plain_text, html) for the morning email."""
    today = datetime.now(tz)
    nice_date = today.strftime("%A, %B %-d, %Y")
    subject = f"Your to-do list — {today.strftime('%a %b %-d')}"

    # ---- plain text ----
    lines = [f"Good morning! Here's your day — {nice_date}", ""]
    lines.append("TODAY'S SCHEDULE")
    if events:
        for e in events:
            row = f"  {e['time']:>9}  {e['title']}"
            lines.append(row)
            if e["detail"]:
                lines.append(f"             {e['detail']}")
    else:
        lines.append("  Nothing on the calendar — open day.")
    lines.append("")

    if mail.get("needs_attention"):
        lines.append("NEEDS A REPLY / ATTENTION")
        for m in mail["needs_attention"]:
            lines.append(f"  • {m['from']}: {m['subject']}")
        lines.append("")

    if mail.get("application_count"):
        lines.append(
            f"PIPELINE: {mail['application_count']} new job application(s) waiting to review."
        )
        lines.append("")

    plain = "\n".join(lines)

    # ---- html ----
    def li(inner: str) -> str:
        return f"<li style='margin:4px 0'>{inner}</li>"

    html_parts = [
        "<div style=\"font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;"
        "max-width:640px;margin:0 auto;color:#1a1a1a\">",
        f"<p style='font-size:15px'>Good morning! Here's your day — "
        f"<strong>{escape(nice_date)}</strong></p>",
        "<h2 style='font-size:16px;border-bottom:2px solid #eee;padding-bottom:4px'>"
        "📅 Today's schedule</h2>",
    ]
    if events:
        html_parts.append("<ul style='list-style:none;padding-left:0'>")
        for e in events:
            detail = ""
            if e["detail"]:
                d = escape(e["detail"])
                # linkify a bare URL inside the detail
                d = re.sub(
                    r"(https?://\S+)",
                    r"<a href='\1'>\1</a>",
                    d,
                )
                detail = f"<div style='color:#666;font-size:13px;margin-left:74px'>{d}</div>"
            html_parts.append(
                li(
                    f"<span style='display:inline-block;width:70px;color:#2563eb;"
                    f"font-weight:600'>{escape(e['time'])}</span>"
                    f"<span style='font-weight:500'>{escape(e['title'])}</span>{detail}"
                )
            )
        html_parts.append("</ul>")
    else:
        html_parts.append("<p style='color:#666'>Nothing on the calendar — open day.</p>")

    if mail.get("needs_attention"):
        html_parts.append(
            "<h2 style='font-size:16px;border-bottom:2px solid #eee;padding-bottom:4px'>"
            "✉️ Needs a reply / attention</h2><ul>"
        )
        for m in mail["needs_attention"]:
            html_parts.append(
                li(f"<strong>{escape(m['from'])}</strong>: {escape(m['subject'])}")
            )
        html_parts.append("</ul>")

    if mail.get("application_count"):
        html_parts.append(
            f"<p style='font-size:15px'>🗂️ <strong>{mail['application_count']}</strong> "
            "new job application(s) waiting to review.</p>"
        )

    html_parts.append(
        "<p style='color:#999;font-size:12px;margin-top:24px'>"
        "Sent automatically by your morning to-do assistant.</p></div>"
    )
    html = "\n".join(html_parts)
    return subject, plain, html


def send_email(creds: Credentials, to_addr: str, subject: str, plain: str, html: str) -> None:
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    msg = MIMEMultipart("alternative")
    msg["To"] = to_addr
    msg["Subject"] = subject
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(html, "html"))
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId="me", body={"raw": raw}).execute()


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> int:
    tz = ZoneInfo(_env("MORNING_TODO_TZ", "America/New_York"))
    calendar_id = _env("MORNING_TODO_CALENDAR", "primary")
    dry_run = _env("MORNING_TODO_DRY_RUN", "0") == "1"
    force = _env("MORNING_TODO_FORCE", "0") == "1"
    send_hour = int(_env("MORNING_TODO_SEND_HOUR", "7"))

    # DST guard: the workflow fires at two UTC times so one always lands on the
    # target local hour. Skip the other one. Manual/dry runs bypass the guard.
    local_hour = datetime.now(tz).hour
    if not (dry_run or force) and local_hour != send_hour:
        print(f"Local hour is {local_hour}, not send hour {send_hour} — skipping this run.")
        return 0

    creds = build_credentials()

    # Each source is isolated so one failure doesn't sink the whole email.
    events: list[dict] = []
    try:
        raw_events = fetch_today_events(creds, calendar_id, tz)
        events = [summarize_event(e, tz) for e in raw_events]
    except Exception as exc:  # noqa: BLE001 - report, keep going
        print(f"WARN: calendar fetch failed: {exc}", file=sys.stderr)

    mail: dict = {}
    try:
        mail = fetch_mail_buckets(creds)
    except Exception as exc:  # noqa: BLE001
        print(f"WARN: gmail fetch failed: {exc}", file=sys.stderr)

    subject, plain, html = compose(events, mail, tz)

    if dry_run:
        print(subject)
        print("=" * len(subject))
        print(plain)
        return 0

    to_addr = _env("MORNING_TODO_TO") or whoami(creds)
    send_email(creds, to_addr, subject, plain, html)
    print(f"Sent morning to-do email to {to_addr}: {len(events)} events, "
          f"{len(mail.get('needs_attention', []))} attention items.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
