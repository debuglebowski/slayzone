import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAgentTurns, type AgentTurnRange } from '@slayzone/agent-turns/client'

/**
 * Agent-turn selection for the continuous-flow chip row. Owns the selected turn,
 * the refresh key that re-runs the server-side turn filter, and the derived
 * from/to sha range used to scope the snapshot fetch.
 */
export function useGitDiffTurns(targetPath: string | null) {
  const [selectedTurnId, setSelectedTurnId] = useState<string | 'all'>('all')
  // Bumped after each working-tree snapshot fetch (via refreshTurns) so the turn
  // list re-runs the server-side filter — turns whose files no longer appear in
  // `git status` get pruned (and stop occupying a numbered slot).
  const [turnsRefreshKey, setTurnsRefreshKey] = useState(0)
  const turns = useAgentTurns(targetPath, turnsRefreshKey)
  const selectedTurn: AgentTurnRange | null = useMemo(
    () => (selectedTurnId === 'all' ? null : (turns.find((t) => t.id === selectedTurnId) ?? null)),
    [selectedTurnId, turns]
  )
  // If the selected turn was filtered out (its files are no longer in working
  // tree changes), fall back to "All turns" — otherwise the chip row would show
  // no active button and the diff would silently switch to all-turns mode
  // without the user realizing.
  useEffect(() => {
    if (selectedTurnId !== 'all' && !turns.some((t) => t.id === selectedTurnId)) {
      setSelectedTurnId('all')
    }
  }, [selectedTurnId, turns])

  // Resolve effective sha range for the current turn selection. For the first
  // turn (no prior snapshot), use the snapshot's parent commit (= HEAD at the
  // moment the snapshot was taken). git accepts `<sha>^` syntax, so the fallback
  // diffs against HEAD-at-snap-time, NOT the empty tree.
  const fromSha = selectedTurn
    ? (selectedTurn.prev_snapshot_sha ?? `${selectedTurn.snapshot_sha}^`)
    : undefined
  const toSha = selectedTurn ? selectedTurn.snapshot_sha : undefined

  const refreshTurns = useCallback(() => setTurnsRefreshKey((k) => k + 1), [])

  return { selectedTurnId, setSelectedTurnId, turns, fromSha, toSha, refreshTurns }
}
