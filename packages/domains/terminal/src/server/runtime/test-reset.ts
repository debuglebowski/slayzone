import {
  setPtyCreateCapture,
  setShuttingDown as setPtyShuttingDown,
  shutdownAllPtys
} from './pty-manager'
import { __resetForTests as resetChatTransports, shutdownAll as shutdownChats } from './chat-transport-manager'
import { __resetForTests as resetWarmPool } from './warm-process-manager'
import { clearAllSessionUserInputMarks } from '../user-input-tracker'
import { beginTerminalShutdown } from './shutdown'

// Short on purpose: e2e agents are disposable, and the reset is on every spec's
// critical path. Same kill escalation as app quit, just tighter.
const RESET_SHUTDOWN = { termGraceMs: 300, hardTimeoutMs: 2_000 }

/**
 * E2E-only: return the terminal runtime to a just-booted state without
 * restarting the process. Replaces the side-car restart the reset used to do.
 *
 * Every pty/chat session is stopped and its exit AWAITED under the shutdown gate,
 * so no exit handler writes `agent_state` into the freshly-wiped DB afterwards.
 * Sessions route through the pty/chat backends, so this also kills agents
 * running on the computer — which the restart never did (the computer keeps its
 * sessions across a hub disconnect, and the fresh hub never swept them).
 */
export async function resetTerminalRuntimeForTest(): Promise<void> {
  setPtyCreateCapture(false)
  beginTerminalShutdown()
  await Promise.all([shutdownAllPtys(RESET_SHUTDOWN), shutdownChats(RESET_SHUTDOWN)]).catch(
    (err: unknown) => console.error('[terminal] test reset: shutdown failed:', err)
  )
  // Kills warm/reserved agents, bumps the pool epoch, re-opens the pool gate.
  resetWarmPool()
  // Clears ended sessions + in-flight spawns, re-opens the chat gate.
  resetChatTransports()
  setPtyShuttingDown(false)
  clearAllSessionUserInputMarks()
}
