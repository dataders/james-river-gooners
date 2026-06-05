import { useState } from 'react'
import { allChangeIds, parseSeen, serializeSeen, hasUnseenChanges } from '../utils/whatsNew'

const STORAGE_KEY = 'gooners-whatsnew-seen'

function readRaw() {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

// "What's New" panel state + per-change "seen" tracking. Each changelog line has
// a stable id; we remember the set the user has already seen in localStorage, so
// a newly added line flags "New" even on an existing day. The header button
// shows a dot while anything is unseen; the panel never auto-opens (opt-in).
export function useWhatsNew() {
  const [open, setOpen] = useState(false)
  // Snapshot the seen set at load so the "New" markers stay stable while the
  // panel is open — closeWhatsNew bumps storage, but this doesn't move until
  // the next reload.
  const [seenIds] = useState(() => parseSeen(readRaw()))
  const [hasUnseen, setHasUnseen] = useState(() => hasUnseenChanges(seenIds))

  function openWhatsNew() {
    setOpen(true)
  }

  function closeWhatsNew() {
    try {
      localStorage.setItem(STORAGE_KEY, serializeSeen(new Set(allChangeIds())))
    } catch {
      // ignore
    }
    setHasUnseen(false)
    setOpen(false)
  }

  return { whatsNewOpen: open, hasUnseen, seenIds, openWhatsNew, closeWhatsNew }
}
