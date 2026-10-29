import { useEffect, useState } from 'react'

/**
 * Keeps content mounted through a CSS exit animation. Replaces framer-motion's
 * AnimatePresence for the simple show/hide case: when `active` flips false the
 * element stays mounted for `exitMs` so `data-[state=closed]` exit classes can
 * play, then unmounts.
 *
 * Returns `mounted` (whether to render at all) and `state` ('open' | 'closed')
 * to drive tw-animate-css `data-[state=...]:animate-in/out` utilities.
 */
export function usePresence(
  active: boolean,
  exitMs = 200
): { mounted: boolean; state: 'open' | 'closed' } {
  const [mounted, setMounted] = useState(active)
  // Mount as soon as `active` turns on — adjusted during render, so the content
  // appears in the same commit instead of one effect pass later.
  if (active && !mounted) setMounted(true)

  useEffect(() => {
    if (active || !mounted) return
    const t = setTimeout(() => setMounted(false), exitMs)
    return () => clearTimeout(t)
  }, [active, mounted, exitMs])

  return { mounted, state: active ? 'open' : 'closed' }
}
