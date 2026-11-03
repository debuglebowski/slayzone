import type { TerminalState } from '@slayzone/terminal-contracts'
import type { PtyAccess } from '../types'

export type PtyWaitResult =
  | { outcome: 'reached'; state: TerminalState; waited: boolean }
  | { outcome: 'dead'; state: 'dead' }
  | { outcome: 'timeout'; state: TerminalState | 'dead' }

/**
 * Wait until PTY `id` reaches `target` — `/api/pty/:id/wait` and `/api/agent/:id/wait`.
 * The caller checked the session is live. Resolves on the state, the session
 * dying, the timeout, or `signal` (then as a timeout nobody reads).
 */
export function waitForPtyState(
  pty: PtyAccess,
  id: string,
  target: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<PtyWaitResult> {
  const current = pty.getState(id)
  if (current === target)
    return Promise.resolve({ outcome: 'reached', state: current, waited: false })
  return new Promise((resolve) => {
    let resolved = false
    const finish = (result: PtyWaitResult): void => {
      if (resolved) return
      resolved = true
      unsubState()
      unsubSession()
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const unsubState = pty.subscribeToStateChange(id, (newState) => {
      if (newState === target) finish({ outcome: 'reached', state: newState, waited: true })
    })
    const unsubSession = pty.onSessionChange(() => {
      if (!pty.hasLivePty(id)) finish({ outcome: 'dead', state: 'dead' })
    })
    const timer = setTimeout(
      () => finish({ outcome: 'timeout', state: pty.getState(id) ?? 'dead' }),
      timeoutMs
    )
    const onAbort = (): void => finish({ outcome: 'timeout', state: pty.getState(id) ?? 'dead' })
    signal.addEventListener('abort', onAbort)
  })
}
