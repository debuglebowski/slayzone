import { useCallback, useMemo, useState } from 'react'
import type { TimelineItem } from '@slayzone/terminal/client'

/**
 * Owns chat-search state: query, case sensitivity, currently-active match
 * index, plus the derived `matchedIndices` (positions in `displayedTimeline`
 * containing the query). Also exposes per-item highlight metadata so renderers
 * can wrap `<mark>` spans around hits.
 *
 * Match-level highlighting (not just item-level): callers can ask
 * `getItemMatches(itemIdx)` to get char offsets for `<mark>` wrapping.
 */
export function useChatSearch(displayedTimeline: TimelineItem[]) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const [focusToken, setFocusToken] = useState(0)

  // Per-item match offsets: itemIndex → array of `{ start, end }` char ranges.
  // Empty for items with no matches; absent itemIndex = no matches.
  const itemMatches = useMemo(() => {
    const map = new Map<number, { start: number; end: number }[]>()
    if (!query) return map
    const needle = caseSensitive ? query : query.toLowerCase()
    if (needle.length === 0) return map
    for (let i = 0; i < displayedTimeline.length; i++) {
      const item = displayedTimeline[i]
      let hay = ''
      switch (item.kind) {
        case 'user-text':
          hay = item.text
          break
        case 'text':
          hay = item.text
          break
        case 'thinking':
          hay = item.text
          break
        case 'result':
          hay = item.text ?? ''
          break
        case 'stderr':
          hay = item.text
          break
        case 'tool': {
          const inv = item.invocation
          hay = `${inv.name} ${typeof inv.input === 'string' ? inv.input : JSON.stringify(inv.input)}`
          break
        }
        default:
          hay = ''
      }
      if (!hay) continue
      const cmp = caseSensitive ? hay : hay.toLowerCase()
      const ranges: { start: number; end: number }[] = []
      let from = 0
      while (true) {
        const at = cmp.indexOf(needle, from)
        if (at < 0) break
        ranges.push({ start: at, end: at + needle.length })
        from = at + needle.length
      }
      if (ranges.length > 0) map.set(i, ranges)
    }
    return map
  }, [query, caseSensitive, displayedTimeline])

  const matchedIndices = useMemo(
    () => Array.from(itemMatches.keys()).sort((a, b) => a - b),
    [itemMatches]
  )

  // Clamp activeIdx when match set shrinks. Adjusted during render (converges
  // in one pass); the values returned below are clamped either way, so this
  // only keeps the stored index in range for next()/prev().
  if (matchedIndices.length === 0) {
    if (activeIdx !== 0) setActiveIdx(0)
  } else if (activeIdx >= matchedIndices.length) {
    setActiveIdx(matchedIndices.length - 1)
  }

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setActiveIdx(0)
  }, [])

  const next = useCallback(() => {
    setActiveIdx((i) => (matchedIndices.length === 0 ? 0 : (i + 1) % matchedIndices.length))
  }, [matchedIndices.length])

  const prev = useCallback(() => {
    setActiveIdx((i) =>
      matchedIndices.length === 0 ? 0 : (i - 1 + matchedIndices.length) % matchedIndices.length
    )
  }, [matchedIndices.length])

  const requestOpen = useCallback(() => {
    setOpen(true)
    setFocusToken((t) => t + 1)
  }, [])

  const activeItemIdx =
    matchedIndices.length > 0 ? matchedIndices[Math.min(activeIdx, matchedIndices.length - 1)] : -1

  return {
    open,
    query,
    setQuery,
    caseSensitive,
    setCaseSensitive,
    matchCount: matchedIndices.length,
    activeIdx: matchedIndices.length > 0 ? Math.min(activeIdx, matchedIndices.length - 1) : -1,
    activeItemIdx,
    matchedIndices,
    itemMatches,
    next,
    prev,
    close,
    requestOpen,
    focusToken
  }
}
