import { useState } from 'react'

const STORAGE_KEY = 'gooners-tutorial-seen'

export function useTutorial() {
  const [open, setOpen] = useState(() => {
    try {
      return !localStorage.getItem(STORAGE_KEY)
    } catch {
      return false
    }
  })

  function openTutorial() {
    setOpen(true)
  }

  function closeTutorial() {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // ignore
    }
    setOpen(false)
  }

  return { tutorialOpen: open, openTutorial, closeTutorial }
}
