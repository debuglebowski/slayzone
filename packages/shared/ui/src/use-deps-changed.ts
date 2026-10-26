import { useState } from 'react'

/**
 * Effect-style dependency check (`Object.is` per slot) for state adjusted during
 * render: keep the last-seen deps in state and act when this returns true — the
 * render-phase twin of an effect re-running on changed deps.
 *
 * `prev === null` = nothing seen yet, i.e. the first render — for adjustments
 * that, as effects, also acted on mount.
 */
export function depsChanged(prev: readonly unknown[] | null, next: readonly unknown[]): boolean {
  return prev === null || prev.length !== next.length || next.some((v, i) => !Object.is(v, prev[i]))
}

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
 *
 * Never key on a value rebuilt during the same render (e.g. an unmemoized array
 * derived from props): it differs on every pass and the adjustment never settles
 * (React #301 "Too many re-renders").
 */
export function useDepsChanged(deps: readonly unknown[], includeMount = false): boolean {
  const [prev, setPrev] = useState<readonly unknown[] | null>(includeMount ? null : deps)
  const changed = depsChanged(prev, deps)
  if (changed) setPrev(deps)
  return changed
}
