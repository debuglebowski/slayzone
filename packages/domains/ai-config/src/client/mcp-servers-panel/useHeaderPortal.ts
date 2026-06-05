import { useEffect, useState } from 'react'

const HEADER_ACTIONS_ID = 'context-manager-header-actions'

export function useHeaderPortal() {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setTarget(document.getElementById(HEADER_ACTIONS_ID))
  }, [])
  return target
}
