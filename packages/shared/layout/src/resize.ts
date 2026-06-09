// Pure resize math — moving one divider trades space between its two neighbors
// only, preserving their summed size and clamping to mins. Mirrors the electron
// app's ResizeHandle contract ("sum of the two neighbors preserved, nothing else
// moves"), generalized to a split node's fraction array.
import { normalizeFractions } from './geometry'

/**
 * Recompute a split's `fractions` after dragging the divider between child
 * `index` and `index + 1` by `deltaPx`. `childMinsPx` is each child's min along
 * the split axis; `totalContentPx` is the split's content extent (rect size
 * minus dividers). Only the two neighbors change.
 */
export function applySplitResize(
  fractions: number[],
  childMinsPx: number[],
  index: number,
  deltaPx: number,
  totalContentPx: number
): number[] {
  const n = fractions.length
  const fr = normalizeFractions(fractions, n)
  if (index < 0 || index >= n - 1 || totalContentPx <= 0) return fr

  const leftOld = fr[index] * totalContentPx
  const rightOld = fr[index + 1] * totalContentPx
  const pair = leftOld + rightOld
  const leftMin = childMinsPx[index] ?? 0
  const rightMin = childMinsPx[index + 1] ?? 0

  const lower = leftMin
  const upper = pair - rightMin
  let newLeft = leftOld + deltaPx
  // If both mins can't fit, pin to left min (content overflows — clipped on render).
  newLeft = lower > upper ? lower : Math.max(lower, Math.min(upper, newLeft))
  const newRight = pair - newLeft

  const out = fr.slice()
  out[index] = newLeft / totalContentPx
  out[index + 1] = newRight / totalContentPx
  return normalizeFractions(out, n)
}

/** Equal fractions for `count` children (divider double-click reset). */
export function resetSplitFractions(count: number): number[] {
  if (count <= 0) return []
  return new Array<number>(count).fill(1 / count)
}
