import { BrowserWindow } from 'electron'
import { agentTurnsEvents } from '../server/events'

/**
 * Legacy IPC bridge for agent-turn changes.
 *
 * The pure domain (`server/turn-tracker.ts`) emits `agent-turns:changed` on
 * `agentTurnsEvents`; the tRPC `agentTurns.onChanged` subscription wraps that
 * emitter. This Electron-only subscriber mirrors each change onto the legacy
 * `agent-turns:changed` + `tasks:changed` `webContents.send` channels so
 * renderers still on IPC keep refreshing. Deleted when the renderer drops IPC
 * (slice 5).
 *
 * `recordTurnBoundary` bumps `tasks.last_interaction_at`, hence the paired
 * `tasks:changed` so the tree-view "Last interaction" sort reorders without
 * waiting for an unrelated reload.
 *
 * Idempotent: invoke once at app boot.
 */
let wired = false

export function initAgentTurnsBroadcast(): void {
  if (wired) return
  wired = true
  agentTurnsEvents.on('agent-turns:changed', (worktreePath) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      w.webContents.send('agent-turns:changed', worktreePath)
      w.webContents.send('tasks:changed')
    }
  })
}
