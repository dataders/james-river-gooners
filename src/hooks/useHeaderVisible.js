import { useState, useEffect, useRef } from 'react'

export function useHeaderVisible(headerHeight = Infinity) {
  const [visible, setVisible] = useState(true)
  const lastScrollY = useRef(0)

  useEffect(() => {
    const handleScroll = () => {
      const currentY = window.scrollY
      if (currentY < headerHeight) {
        setVisible(true)
      } else if (currentY > lastScrollY.current + 5) {
        setVisible(false)
      } else if (currentY < lastScrollY.current - 5) {
        setVisible(true)
      }
      lastScrollY.current = currentY
    }

    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [headerHeight])

  return visible
}
