// @ts-nocheck
import { CHANGELOG } from '../data/changelog.js'

// Every change id across the changelog, in display order.
export function allChangeIds(changelog = CHANGELOG) {
  return changelog.flatMap(release => release.changes.map(change => change.id))
}

const LEGACY_DATE = /^\d{4}-\d{2}-\d{2}$/

// Parse the stored "seen" value into a Set of seen change ids. Handles three
// shapes so the badge stays accurate across upgrades:
//   - a JSON array of ids (current format) → that set
//   - a legacy "YYYY-MM-DD" date (the old per-release marker) → every change
//     from releases dated on or before it, so already-seen lines stay seen
//   - empty / unparseable → nothing seen (everything shows "New" once)
export function parseSeen(raw, changelog = CHANGELOG) {
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set(parsed)
  } catch {
    // not JSON — fall through to the legacy-date check
  }
  if (LEGACY_DATE.test(raw)) {
    const ids = changelog
      .filter(release => release.date <= raw)
      .flatMap(release => release.changes.map(change => change.id))
    return new Set(ids)
  }
  return new Set()
}

export function serializeSeen(seen) {
  return JSON.stringify([...seen])
}

// True when any change hasn't been seen yet — drives the header dot.
export function hasUnseenChanges(seen, changelog = CHANGELOG) {
  return allChangeIds(changelog).some(id => !seen.has(id))
}