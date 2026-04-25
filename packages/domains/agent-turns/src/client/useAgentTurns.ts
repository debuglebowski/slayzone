import { useEffect, useState, useCallback } from 'react'
import type { AgentTurnRange } from '../shared/types'

/**
 * Returns all turns for the given worktree path, oldest first. Re-fetches
 * when `agent-turns:changed` IPC fires for the same path, OR when the
 * optional `refreshKey` changes identity (used to retrigger after working
 * tree state changes — server-side filter prunes turns whose files no
 * longer appear in `git status`).
 */
export function useAgentTurns(
  worktreePath: string | null | undefined,
  refreshKey?: unknown
): AgentTurnRange[] {
  const [turns, setTurns] = useState<AgentTurnRange[]>([])

  const reload = useCallback(async () => {
    if (!worktreePath) {
      setTurns([])
      return
    }
    const list = await window.api.agentTurns.list(worktreePath)
    setTurns(list)
  }, [worktreePath])

  useEffect(() => {
    void reload()
  }, [reload, refreshKey])

  useEffect(() => {
    if (!worktreePath) return
    const norm = (p: string) => p.replace(/\/+$/, '')
    const target = norm(worktreePath)
    const off = window.api.agentTurns.onChanged((changedPath) => {
      // Strict equality after trailing-slash normalization. Avoids false
      // positives from suffix-match when two worktree paths share a tail.
      if (norm(changedPath) === target) {
        void reload()
      }
    })
    return () => off()
  }, [worktreePath, reload])

  return turns
}
