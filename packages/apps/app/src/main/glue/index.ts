/**
 * Phase 1 server-mode glue layer.
 *
 * Domain `server/` packages are framework-free: they emit events on a typed
 * EventEmitter instead of calling Electron-specific `BrowserWindow.webContents.send`.
 * This module subscribes to every domain emitter at app boot and forwards the
 * events to the renderer via `broadcastToWindows`.
 *
 * Phase 2 (tRPC) will replace these forwarders with subscription publishers;
 * the domain emitters themselves stay unchanged.
 */
import { broadcastToWindows } from '../broadcast-to-windows'
import { agentTurnsEvents } from '@slayzone/agent-turns/server'
import { getGitWatcher } from '@slayzone/worktrees/server'

export function wireDomainEvents(): void {
  agentTurnsEvents.on('agent-turns:changed', (worktreePath) => {
    broadcastToWindows('agent-turns:changed', worktreePath)
  })

  const gitWatcher = getGitWatcher()
  gitWatcher.on('git:diff-changed', (payload) => {
    broadcastToWindows('git:diff-changed', payload)
  })
  gitWatcher.on('git:diff-watch-failed', (payload) => {
    broadcastToWindows('git:diff-watch-failed', payload)
  })
}
