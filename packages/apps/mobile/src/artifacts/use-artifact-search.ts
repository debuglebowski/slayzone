/**
 * `searchArtifacts` as you type: a search starts 300 ms after the query (or its options)
 * last changed — desktop's panel search waits the same way — and a newer one cancels the
 * one in flight, so only the latest query's results ever land.
 */
import { useEffect, useRef, useState } from 'react'
import type { HubTarget } from './hub-rest'
import { type ArtifactSearchOutcome, type ArtifactSearchQuery, searchArtifacts } from './search'

export const SEARCH_DEBOUNCE_MS = 300

export interface ArtifactSearchState {
  /** The last finished search's outcome, for exactly the query on screen; null = none. */
  outcome: ArtifactSearchOutcome | null
  searching: boolean
}

interface Finished {
  key: string
  outcome: ArtifactSearchOutcome
}

/**
 * What a search is for, as one value: the effect re-runs when it changes, not its parts'
 * identity. A target's in-process API (`http`, a function) is not part of it (JSON drops
 * it); the targets themselves are read from `latest`.
 */
const keyOf = (targets: readonly HubTarget[], query: ArtifactSearchQuery): string =>
  JSON.stringify([targets, query])

export function useArtifactSearch(
  targets: readonly HubTarget[],
  query: ArtifactSearchQuery
): ArtifactSearchState {
  const key = keyOf(targets, query)
  const blank = !query.q.trim()
  const [finished, setFinished] = useState<Finished | null>(null)
  // The targets of the render `key` came from (effects run in order: this one first).
  const latest = useRef(targets)
  useEffect(() => {
    latest.current = targets
  })

  useEffect(() => {
    if (blank) return
    const controller = new AbortController()
    const hubs = latest.current
    const [, q] = JSON.parse(key) as [unknown, ArtifactSearchQuery]
    const timer = setTimeout(() => {
      searchArtifacts(hubs, q, { signal: controller.signal })
        .then((outcome) => {
          if (!controller.signal.aborted) setFinished({ key, outcome })
        })
        .catch(() => {
          // Only an aborted search rejects here (per-hub failures are in the outcome).
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [key, blank])

  const current = finished && finished.key === key ? finished.outcome : null
  return { outcome: blank ? null : current, searching: !blank && current === null }
}
