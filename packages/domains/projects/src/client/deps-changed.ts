/**
 * Effect-style dependency check (`Object.is` per slot) for state adjusted
 * during render: keep the last-seen deps in state and act when this returns
 * true — the render-phase twin of an effect re-running on changed deps.
 *
 * `prev === null` = nothing seen yet, i.e. the first render — for adjustments
 * that, as effects, also acted on mount.
 */
export function depsChanged(prev: readonly unknown[] | null, next: readonly unknown[]): boolean {
  return prev === null || prev.length !== next.length || next.some((v, i) => !Object.is(v, prev[i]))
}
