/**
 * Which agents are starting right now, and how far each one got.
 *
 * Restoring a workspace starts every open tab's agent, and the computer admits
 * them a few at a time (`computer/spawn-admission.ts`). Until now that showed only
 * as "everything is slow": every tab sat in `starting`, with no way to tell an
 * agent still waiting for a start slot from one already launched. The sidebar's
 * startup card reads this tracker (`pty.onAgentStarts`) to say so.
 *
 * An entry exists exactly while its session is `starting`:
 *   - `queued`  — the start was asked for; its process has not been launched yet
 *                 (waiting for an admission slot on its computer);
 *   - `booting` — the process runs but has not printed its first output.
 * Both runtimes feed it at their single state-transition point (pty-manager's
 * `emitStateChange`, chat-transport-manager's `transitionState`), so an entry
 * leaves the moment its session leaves `starting` — first output, exit, kill,
 * tab close — and can never outlive it.
 *
 * @module terminal/server/runtime/agent-starts
 */

export type AgentStartPhase = 'queued' | 'booting'

export interface AgentStartEntry {
  sessionId: string
  phase: AgentStartPhase
}

export interface AgentStartTracker {
  /** The session is starting, in `phase`. */
  mark(sessionId: string, phase: AgentStartPhase): void
  /** Its process was launched. Only moves a `queued` entry; never adds one. */
  markBooting(sessionId: string): void
  /** The session is no longer starting. */
  clear(sessionId: string): void
  /** Every agent starting now, in the order they were first marked. */
  snapshot(): AgentStartEntry[]
  /** Called with the full snapshot after each burst of changes (coalesced). */
  subscribe(listener: (entries: AgentStartEntry[]) => void): () => void
}

export interface AgentStartTrackerOptions {
  /** Defers the change notification; a burst of marks in one tick is one notification. */
  schedule?: (fn: () => void) => void
}

export function createAgentStartTracker(opts: AgentStartTrackerOptions = {}): AgentStartTracker {
  const schedule = opts.schedule ?? ((fn: () => void) => setImmediate(fn))
  const phases = new Map<string, AgentStartPhase>()
  const listeners = new Set<(entries: AgentStartEntry[]) => void>()
  let notifyScheduled = false

  const snapshot = (): AgentStartEntry[] =>
    [...phases].map(([sessionId, phase]) => ({ sessionId, phase }))

  const changed = (): void => {
    if (notifyScheduled || listeners.size === 0) return
    notifyScheduled = true
    schedule(() => {
      notifyScheduled = false
      const entries = snapshot()
      for (const listener of [...listeners]) listener(entries)
    })
  }

  return {
    mark(sessionId, phase) {
      if (phases.get(sessionId) === phase) return
      phases.set(sessionId, phase)
      changed()
    },
    markBooting(sessionId) {
      if (phases.get(sessionId) !== 'queued') return
      phases.set(sessionId, 'booting')
      changed()
    },
    clear(sessionId) {
      if (phases.delete(sessionId)) changed()
    },
    snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** This hub's tracker: one per process, fed by both the pty and the chat runtime. */
export const agentStarts = createAgentStartTracker()
