import { useState } from 'react'

/**
 * True on each render whose `deps` differ (element-wise `Object.is`) from the
 * previous render's — and on the first render too when `includeMount` — so the
 * caller can adjust its own state during that render instead of in an effect
 * ("adjusting state while rendering", react.dev/learn/you-might-not-need-an-effect).
 *
 * Mirrors an effect's trigger set: an effect runs on mount and whenever its deps
 * change, so `useDepsChanged(deps, true)` fires exactly where `useEffect(…, deps)`
 * would, one commit earlier. The deps array wraps every value, so function-typed
 * deps (a tRPC client proxy) are stored, never invoked as a state initializer.
 */
export function useDepsChanged(deps: readonly unknown[], includeMount = false): boolean {
  const [prev, setPrev] = useState<readonly unknown[] | null>(includeMount ? null : deps)
  const changed =
    prev === null || prev.length !== deps.length || prev.some((d, i) => !Object.is(d, deps[i]))
  if (changed) setPrev(deps)
  return changed
}
