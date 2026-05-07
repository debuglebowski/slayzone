/**
 * Phase 2 server-mode glue layer.
 *
 * Domain server packages emit events on typed EventEmitters. This module
 * forwards those that aren't yet exposed via tRPC subscriptions to the
 * renderer via legacy webContents broadcasts. Each entry below is removed
 * as its subscription router lands.
 */
import { broadcastToWindows } from '../broadcast-to-windows'
import { getGitWatcher } from '@slayzone/worktrees/server'

export function wireDomainEvents(): void {
  // agentTurnsEvents → tRPC subscription `agentTurns.onChanged` (P6).

  const gitWatcher = getGitWatcher()
  gitWatcher.on('git:diff-changed', (payload) => {
    broadcastToWindows('git:diff-changed', payload)
  })
  gitWatcher.on('git:diff-watch-failed', (payload) => {
    broadcastToWindows('git:diff-watch-failed', payload)
  })
}
