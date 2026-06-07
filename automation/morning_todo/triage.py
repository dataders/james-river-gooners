#!/usr/bin/env python3
"""AI inbox triage for the morning to-do email.

An optional upgrade over the simple unread heuristic in ``main.py``. When an
``ANTHROPIC_API_KEY`` is present and the ``anthropic`` SDK imports, this:

  1. Finds inbox threads whose **last** message is from someone other than you —
     so it catches threads you've *read but not replied to*, not just unread
     mail (the gap that lets a real to-do slip off the list).
  2. Asks Claude to decide which genuinely need a reply/action from you, and to
     write a ready-to-send **draft reply in your voice**.
  3. Creates those drafts in Gmail (skipping any thread that already has a
     draft, so days don't pile up duplicates) and returns the action list.

Gated exactly like the scraper's enrichment: miss the key or the SDK and the
caller falls back to the lightweight unread digest, so nothing breaks.

Model + structured-output shape mirror ``scraper/enrich.py`` for consistency.
"""

from __future__ import annotations

import base64
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from email.mime.text import MIMEText
from email.utils import parseaddr

from googleapiclient.discovery import build

MODEL = os.environ.get("MORNING_TODO_MODEL", "claude-haiku-4-5")
MAX_TRIAGE = int(os.environ.get("MORNING_TODO_MAX_TRIAGE", "15"))
LOOKBACK_DAYS = int(os.environ.get("MORNING_TODO_TRIAGE_LOOKBACK_DAYS", "7"))
MAX_WORKERS = int(os.environ.get("MORNING_TODO_TRIAGE_WORKERS", "4"))
BODY_CHARS = 2400  # plenty for triage; keeps token cost negligible

# Same belt-and-suspenders bulk denylist as main.py's heuristic path.
BULK_SENDER_HINTS = (
    "no-reply", "noreply", "newsletter", "notifications@", "donotreply",
    "mailer-daemon", "calendar-notification@", "jobs-listings@", "@linkedin.com",
)

SYSTEM_PROMPT = (
    "You triage the inbox of Jay Hine (jay@pragmaticresource.com), who runs "
    "Pragmatic Resource, a talent/recruiting firm. You are given the most recent "
    "message in a thread that Jay has NOT yet replied to. Decide whether it needs "
    "Jay to reply or take an action, and if so write a concise, professional draft "
    "reply in Jay's first-person voice that he can review and send.\n"
    "Rules:\n"
    "- Mark category fyi_no_action for newsletters, marketing, receipts, automated "
    "notifications, calendar accept/decline notices, and anything that does not "
    "need Jay personally. For those, needs_action=false and empty strings.\n"
    "- category reply_needed when Jay should write back; action_needed when he must "
    "do something but not necessarily reply (e.g. review a document, make a call).\n"
    "- suggested_action: one short imperative line (e.g. \"Reply with your "
    "availability for next week\"). Empty if no action.\n"
    "- draft_reply: a ready-to-send reply, only for reply_needed. Keep it brief and "
    "warm. NEVER invent facts, dates, prices, or commitments; if specifics are "
    "unknown, move things forward without fabricating (propose to follow up, ask a "
    "clarifying question, or acknowledge and promise a timeline). Empty for "
    "action_needed/fyi_no_action.\n"
    "Base everything only on the email shown."
)

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "needs_action": {"type": "boolean"},
        "category": {"type": "string", "enum": ["reply_needed", "action_needed", "fyi_no_action"]},
        "suggested_action": {"type": "string"},
        "draft_reply": {"type": "string"},
    },
    "required": ["needs_action", "category", "suggested_action", "draft_reply"],
    "additionalProperties": False,
}


def is_triage_enabled() -> bool:
    """True only when a key is present AND the SDK imports — otherwise the caller
    falls back to the simple unread digest."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return False
    try:
        import anthropic  # noqa: F401
    except ImportError:
        print("  triage: anthropic SDK not installed; using simple digest", file=sys.stderr)
        return False
    return True


def _make_client():
    import anthropic
    return anthropic.Anthropic(max_retries=2)


# --------------------------------------------------------------------------- #
# Gmail reading
# --------------------------------------------------------------------------- #

def _header(payload: dict, name: str) -> str:
    for h in payload.get("headers", []):
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _is_bulk(sender: str) -> bool:
    low = sender.lower()
    return any(hint in low for hint in BULK_SENDER_HINTS)


def _decode(data: str) -> str:
    return base64.urlsafe_b64decode(data.encode()).decode("utf-8", errors="replace")


def _extract_body(payload: dict) -> str:
    """Depth-first walk for the first text/plain part; fall back to stripped html."""
    mime = payload.get("mimeType", "")
    body = payload.get("body", {})
    if mime == "text/plain" and body.get("data"):
        return _decode(body["data"])
    html_fallback = ""
    for part in payload.get("parts", []) or []:
        text = _extract_body(part)
        if text:
            if part.get("mimeType") == "text/html":
                html_fallback = html_fallback or text
            else:
                return text
    if mime == "text/html" and body.get("data"):
        html_fallback = html_fallback or _decode(body["data"])
    if html_fallback:
        import re
        return re.sub(r"<[^>]+>", " ", html_fallback)
    return ""


def find_candidates(service, me_email: str) -> list[dict]:
    """Inbox threads where the latest message is from someone else and Jay hasn't
    replied. Skips bulk senders and threads that already hold a draft."""
    me = me_email.lower()
    resp = (
        service.users()
        .threads()
        .list(userId="me", q=f"in:inbox category:primary newer_than:{LOOKBACK_DAYS}d",
              maxResults=MAX_TRIAGE)
        .execute()
    )
    candidates: list[dict] = []
    for ref in resp.get("threads", []):
        thread = service.users().threads().get(userId="me", id=ref["id"], format="full").execute()
        msgs = thread.get("messages", [])
        if not msgs:
            continue
        # Already drafted (today or a prior morning)? Don't create a duplicate.
        has_draft = any("DRAFT" in m.get("labelIds", []) for m in msgs)
        last = msgs[-1]
        payload = last.get("payload", {})
        sender = _header(payload, "From")
        if me in sender.lower():
            continue  # Jay sent the last message — ball's in their court
        if _is_bulk(sender):
            continue
        name, email_addr = parseaddr(sender)
        candidates.append({
            "thread_id": thread["id"],
            "message_id": last["id"],
            "rfc822_msgid": _header(payload, "Message-ID"),
            "from_name": (name or email_addr or sender).strip().strip('"'),
            "from_email": email_addr,
            "subject": _header(payload, "Subject") or "(no subject)",
            "date": _header(payload, "Date"),
            "body": _extract_body(payload).strip()[:BODY_CHARS],
            "has_draft": has_draft,
        })
    return candidates


# --------------------------------------------------------------------------- #
# Claude classification
# --------------------------------------------------------------------------- #

def _response_text(content) -> str:
    return next((b.text for b in content if getattr(b, "type", None) == "text"), "")


def classify(client, cand: dict) -> dict:
    user = (
        f"From: {cand['from_name']} <{cand['from_email']}>\n"
        f"Date: {cand['date']}\n"
        f"Subject: {cand['subject']}\n\n"
        f"{cand['body'] or '(no readable body)'}"
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=700,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user}],
        output_config={"format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
    )
    import json
    return json.loads(_response_text(resp.content))


# --------------------------------------------------------------------------- #
# Draft creation
# --------------------------------------------------------------------------- #

def create_draft_reply(service, cand: dict, body_text: str) -> bool:
    subject = cand["subject"]
    if not subject.lower().startswith("re:"):
        subject = "Re: " + subject
    mime = MIMEText(body_text, "plain")
    mime["To"] = cand["from_email"]
    mime["Subject"] = subject
    if cand.get("rfc822_msgid"):
        mime["In-Reply-To"] = cand["rfc822_msgid"]
        mime["References"] = cand["rfc822_msgid"]
    raw = base64.urlsafe_b64encode(mime.as_bytes()).decode()
    service.users().drafts().create(
        userId="me",
        body={"message": {"raw": raw, "threadId": cand["thread_id"]}},
    ).execute()
    return True


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #

def run_triage(creds, me_email: str) -> list[dict]:
    """Return action items: [{from, subject, category, suggested_action,
    draft_created}]. Creates Gmail draft replies as a side effect."""
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    candidates = find_candidates(service, me_email)
    if not candidates:
        return []

    client = _make_client()

    def _safe_classify(cand):
        try:
            return cand, classify(client, cand)
        except Exception as exc:  # noqa: BLE001 — isolate per-email failures
            print(f"WARN: triage classify failed for '{cand['subject']}': {exc}", file=sys.stderr)
            return cand, None

    results = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        for cand, verdict in pool.map(_safe_classify, candidates):
            if not verdict or not verdict.get("needs_action"):
                continue
            results.append((cand, verdict))

    actions = []
    for cand, verdict in results:
        draft_created = False
        draft_reply = (verdict.get("draft_reply") or "").strip()
        if (verdict.get("category") == "reply_needed" and draft_reply
                and not cand["has_draft"]):
            try:
                draft_created = create_draft_reply(service, cand, draft_reply)
            except Exception as exc:  # noqa: BLE001
                print(f"WARN: draft create failed for '{cand['subject']}': {exc}", file=sys.stderr)
        actions.append({
            "from": cand["from_name"],
            "subject": cand["subject"],
            "category": verdict.get("category", ""),
            "suggested_action": (verdict.get("suggested_action") or "").strip(),
            "draft_created": draft_created,
            "draft_exists": cand["has_draft"],
        })
    return actions
