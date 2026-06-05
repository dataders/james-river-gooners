import { useState } from 'react'
import { LATEST_CHANGELOG_DATE } from '../data/changelog'

const STORAGE_KEY = 'gooners-whatsnew-seen'

function readSeen() {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

// "What's New" panel state + an unseen-updates badge. The badge shows when the
// newest changelog entry is dated after the last date the user opened the
// panel. Unlike the tutorial it never auto-opens — it's opt-in via the header.
export function useWhatsNew() {
  const [open, setOpen] = useState(false)
  // The date the user had already seen when this session loaded. Captured once
  // so the per-release "New" markers in the panel stay stable while it's open —
  // closeWhatsNew bumps the stored value, but this snapshot doesn't move until
  // the next reload. Compare ISO date strings lexicographically (YYYY-MM-DD
  // sorts correctly).
  const [lastSeen] = useState(readSeen)
  const [hasUnseen, setHasUnseen] = useState(() => readSeen() < LATEST_CHANGELOG_DATE)

  function openWhatsNew() {
    setOpen(true)
  }

  function closeWhatsNew() {
    try {
      localStorage.setItem(STORAGE_KEY, LATEST_CHANGELOG_DATE)
    } catch {
      // ignore
    }
    setHasUnseen(false)
    setOpen(false)
  }

  return { whatsNewOpen: open, hasUnseen, lastSeen, openWhatsNew, closeWhatsNew }
}
