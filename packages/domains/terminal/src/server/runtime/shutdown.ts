import { setShuttingDown as setPtyShuttingDown } from './pty-manager'
import { setShuttingDown as setChatShuttingDown } from './chat-transport-manager'

/**
 * Flip the per-subprocess-manager shutdown gates. Spawn/exit handlers check
 * the gate and leave `terminal_tabs.agent_state` at `running`, so the next boot
 * can auto-restart warm agents. Composition root MUST call this BEFORE
 * `killAllPtys()` / `shutdownChatTransports()` during app quit —
 * the kill cascade fires exit handlers, and without the gate set first
 * they'd record `stopped` and defeat the restore.
 */
export function beginTerminalShutdown(): void {
  setPtyShuttingDown(true)
  setChatShuttingDown(true)
}
