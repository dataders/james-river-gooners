# Morning Briefing

Generate a daily morning briefing focused on recruiting and personal life. Pull live data from Gmail, Google Calendar, and Otter AI, then produce a clean, actionable summary.

## Steps

### 1. Pull data in parallel

Run all three of these simultaneously:

**Gmail** — call `mcp__Gmail__search_threads` twice in parallel:
- Unread inbox from the last 48 hours: `is:unread newer_than:2d in:inbox`
- Recent Otter AI summaries: `from:no-reply@otter.ai newer_than:3d`

**Google Calendar** — call `mcp__Google_Calendar__list_events` twice in parallel:
- Yesterday's events: from `[yesterday]T00:00:00` to `[today]T00:00:00`, timezone `America/New_York`
- Today's events: from `[today]T00:00:00` to `[tomorrow]T00:00:00`, timezone `America/New_York`

**Otter AI** — call `mcp__Otter_ai__search` for meetings in the last 2 days:
- `created_after`: yesterday in `YYYY/MM/DD` format
- `query`: "meetings"

### 2. Get full detail on key items

After the parallel pull:
- For any Otter meeting that has action items or a summary, fetch the full record with `mcp__Otter_ai__fetch` using the meeting ID
- Scan Gmail snippets and identify threads that need a real response (not newsletters, job board notifications, or vendor pitches) — get full content on those with `mcp__Gmail__get_thread`

### 3. Format the brief

Produce the brief in this exact structure. Keep it tight — this is a morning scan, not a report.

---

# Morning Briefing — [Day, Month Date]

## Yesterday's Meetings
Table: Time | Meeting | Outcome/Notes
- Summarise each calendar event that was a call or meeting
- Flag which ones Otter recorded vs. missed
- For recorded meetings: pull key outcomes and action items from Otter

## Carry-Forward Action Items
Checkbox list of unresolved action items from yesterday's Otter meeting notes.

## Today's Schedule
Table: Time | Event | Note
- Work calls and meetings only (not personal appointments like therapy or workouts unless they affect scheduling)
- Flag any attendees who haven't accepted invites

## New Applications / Candidates (Recruiting)
- Count and list new LinkedIn and ZipRecruiter applications by role
- Note any candidate names worth flagging

## Inbox — Needs Action
- Only threads that need a real response or decision
- Skip newsletters, vendor pitches, job board digests, marketing emails

## Today's To-Do List
Checkbox list combining:
- Carry-forward items from yesterday
- Today's prep (call prep, follow-ups)
- Candidate review tasks
- Any time-sensitive emails

---

## Tone and focus

- **Recruiting first**: candidate calls, applications, pipeline, BD outreach
- **Personal life second**: family calendar events (if available), personal commitments that affect the day
- **Skip entirely**: anything related to the James River Gooners / Cannon's auction site — that is a separate project and does not belong in the morning brief
- Be direct and brief. No preamble, no "here is your briefing". Just the brief.
