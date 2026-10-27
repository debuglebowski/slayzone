import * as React from 'react'

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

// The media query only signals crossings; the value itself is read from
// `window.innerWidth`, as it always has been.
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}

function getSnapshot(): boolean {
  return window.innerWidth < MOBILE_BREAKPOINT
}

export function useIsMobile(): boolean {
  return React.useSyncExternalStore(subscribe, getSnapshot)
}
