import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'
import { waterLevel } from './card-water-fill'

/**
 * Sizes the open cards of the settings cards-grid so they SHARE the available
 * height without any one card taking more than it needs.
 *
 * The behaviour we want, per card:
 *   - hug its content (short/empty cards stay small — can be below `minPx`)
 *   - if content is tall, cap it so it can't eat its neighbours' space, and
 *     let the unused space of short neighbours flow to the tall ones
 *     (redistribution) — the capped card scrolls internally
 *   - never squeezed below `minPx` purely by sharing pressure; when even
 *     `minPx` per open card doesn't fit, the grid itself scrolls instead of
 *     clipping
 *
 * None of that is expressible in static CSS grid (`fr` force-fills, `%` needs a
 * definite track height, `fit-content` can't see its siblings). So we compute a
 * single "water level" L such that `Σ min(contentᵢ, L) = available`, then apply
 * it uniformly as `grid-template-rows: fit-content(L)` per open card. One
 * scalar drives every card: `fit-content(L)` hugs cards shorter than L and caps
 * the rest at L — which is exactly water-filling.
 *
 * Measurements are cap-INDEPENDENT (natural content height via the inner
 * scroller's `scrollHeight`; available height via the grid's `clientHeight`,
 * which a `flex-1 min-h-0 overflow-y-auto` grid derives from its siblings, not
 * its own rows). So recompute is idempotent — setting the rows never changes
 * the inputs, so there is no observer feedback loop.
 *
 * The grid must contain `[data-card]` children, each carrying
 * `data-card-open="true|false"`. The scrollable region inside an open card is
 * found via `[data-card-scroll]` (falls back to `.mk-doc-scroll` for the
 * rich-text editor). Closed cards collapse to `auto` (header height).
 */
export function useSharedCardHeights(
  gridRef: RefObject<HTMLElement | null>,
  deps: unknown[],
  minPx = 144
): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return

    const scrollSelector = '[data-card-scroll], .mk-doc-scroll'

    const measure = (): void => {
      const cards = Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-card]'))
      if (cards.length === 0) {
        grid.style.minHeight = ''
        grid.style.gridTemplateRows = ''
        return
      }

      const rowGap = parseFloat(getComputedStyle(grid).rowGap) || 0
      const gaps = rowGap * Math.max(0, cards.length - 1)

      // Natural content height per OPEN card (cap-independent — read from the
      // inner scroller's scrollHeight). Closed cards contribute their header.
      const openNaturals: number[] = []
      let openFloor = 0
      let closedSum = 0
      for (const card of cards) {
        if (card.getAttribute('data-card-open') !== 'true') {
          closedSum += card.offsetHeight
          continue
        }
        const scroll = card.querySelector<HTMLElement>(scrollSelector)
        const natural = scroll
          ? card.clientHeight - scroll.clientHeight + scroll.scrollHeight // chrome + content
          : card.scrollHeight // editor not mounted yet (Suspense fallback)
        openNaturals.push(natural)
        openFloor += Math.min(natural, minPx)
      }

      // The grid must always be tall enough to show every open card at least at
      // its floor (or its content, if shorter) — so a short window scrolls the
      // panel instead of crushing the cards to nothing. This floor is
      // cap-independent, so `avail` below stays a fixed point (no observer loop).
      const minHeight = Math.ceil(openFloor + closedSum + gaps)
      grid.style.minHeight = `${minHeight}px`

      // `avail` = max(flex free space, minHeight). Reading clientHeight after
      // writing minHeight reflects the clamp. Space for the open rows excludes
      // the gaps and the closed headers.
      const avail = grid.clientHeight
      const availForOpen = avail - gaps - closedSum

      const level = waterLevel(openNaturals, availForOpen, minPx)
      const rows = cards
        .map((card) => {
          if (card.getAttribute('data-card-open') !== 'true') return 'auto'
          return level === Infinity ? 'max-content' : `fit-content(${Math.round(level)}px)`
        })
        .join(' ')
      grid.style.gridTemplateRows = rows
    }

    let raf = 0
    const schedule = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(measure)
    }

    measure()

    const ro = new ResizeObserver(schedule)
    ro.observe(grid)
    // Observe the content elements (the scroller and its first child) so the
    // level recomputes when content grows/shrinks — the scroller's own box may
    // not change when it's capped, but the content child's box does.
    for (const scroll of grid.querySelectorAll<HTMLElement>(scrollSelector)) {
      ro.observe(scroll)
      if (scroll.firstElementChild) ro.observe(scroll.firstElementChild)
    }
    // Cards added/removed (mode change), open-state flips, and lazy editor mount
    // all show up as DOM mutations.
    const mo = new MutationObserver(schedule)
    mo.observe(grid, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-card-open']
    })

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, deps)
}
