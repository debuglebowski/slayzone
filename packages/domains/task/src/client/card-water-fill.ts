/**
 * Water-filling for the settings cards-grid. Given the natural content height of
 * each open card and the height available to share, returns the largest cap `L`
 * such that `Σ min(naturalᵢ, L) = available` — i.e. short cards keep their
 * content and tall cards split the leftover evenly at level `L` (scrolling
 * internally above it). `L` is floored at `minPx` so sharing pressure alone
 * never squeezes a card below the floor.
 *
 *   - `Infinity` → everything already fits; no cap, every card hugs its content.
 *   - `minPx`    → even one floor per card overflows `available`; the grid will
 *                  exceed its box and the panel scrolls instead of clipping.
 *
 * Pure function (no DOM/React) so it can be unit-tested directly.
 */
export function waterLevel(naturals: number[], available: number, minPx: number): number {
  if (naturals.length === 0) return Infinity
  const total = naturals.reduce((sum, n) => sum + n, 0)
  if (total <= available) return Infinity

  const sorted = [...naturals].sort((a, b) => a - b)
  let remaining = available
  for (let i = 0; i < sorted.length; i++) {
    const level = remaining / (sorted.length - i)
    if (sorted[i] <= level) {
      remaining -= sorted[i]
      continue
    }
    return Math.max(level, minPx)
  }
  // All cards fit under their fair share (shouldn't reach here given total >
  // available, but keep it safe).
  return Math.max(remaining, minPx)
}
