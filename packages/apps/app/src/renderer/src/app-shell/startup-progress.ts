import type { StartupProgress } from '@slayzone/sidebar'

/**
 * When the sidebar's startup card shows, and what it counts.
 *
 * A restored workspace comes up in stages, each deliberately paced so the tab the
 * user looks at is first: hidden tabs load one per idle slice (`pane-hydration`),
 * their terminals take turns to initialise (`terminal-init-scheduler`), and their
 * agents are admitted a few at a time on the computer (`pty.onAgentStarts`). With
 * dozens of tabs that takes a while, and until now it only looked like a freeze.
 *
 * "Startup" is this renderer's first stretch of such work. It ends — for good —
 * once nothing has been in flight for {@link STARTUP_QUIET_MS} (the gap covers a
 * tab handing over to its terminal, and that terminal to its agent start). The
 * card shows only when startup is still going after {@link STARTUP_SHOW_AFTER_MS},
 * so a fast boot never flashes it.
 */

export const STARTUP_SHOW_AFTER_MS = 1_000
export const STARTUP_QUIET_MS = 3_000

export interface StartupInputs {
  /** Agents starting on the hub; `null` until the hub's first snapshot arrives. */
  agents: ReadonlyArray<{ sessionId: string; phase: 'queued' | 'booting' }> | null
  panes: { hydrated: number; queued: number }
  /** Hidden terminals waiting for their turn to initialise. */
  terminalsQueued: number
}

export interface StartupView {
  visible: boolean
  progress: StartupProgress | null
  /** When to call `update` again even if no input changes (null: no need). */
  recheckAt: number | null
  /** Startup is over, for good: nothing more to watch. */
  ended: boolean
}

const ENDED: StartupView = { visible: false, progress: null, recheckAt: null, ended: true }

export function createStartupWatch(startedAt: number) {
  /** Every agent seen starting during startup — the denominator. */
  const seen = new Set<string>()
  let quietSince: number | null = null
  let done = false
  let shownBefore = false

  const update = (inputs: StartupInputs, now: number): StartupView => {
    if (done) return ENDED
    const agents = inputs.agents ?? []
    for (const a of agents) seen.add(a.sessionId)
    const inFlight = agents.length > 0 || inputs.panes.queued > 0 || inputs.terminalsQueued > 0
    // Startup cannot be over before the hub has said which agents are starting.
    const known = inputs.agents !== null

    if (inFlight || !known) quietSince = null
    else {
      quietSince ??= now
      if (now - quietSince >= STARTUP_QUIET_MS) {
        done = true
        return ENDED
      }
    }

    const tabsTotal = inputs.panes.hydrated + inputs.panes.queued
    const progress: StartupProgress = {
      settled: !inFlight && known,
      agentsReady: seen.size - agents.length,
      agentsTotal: seen.size,
      agentsBooting: agents.filter((a) => a.phase === 'booting').length,
      agentsQueued: agents.filter((a) => a.phase === 'queued').length,
      tabsLoaded: inputs.panes.hydrated,
      tabsTotal
    }
    const shown = now - startedAt >= STARTUP_SHOW_AFTER_MS
    // Appears only while work is still in flight once the delay is up — a boot that
    // finished first never flashes it. Once on screen it stays through the quiet
    // spell (as "Ready") instead of flickering between stages.
    const visible = shown && (inFlight || shownBefore)
    if (visible) shownBefore = true

    const rechecks = [
      shown ? null : startedAt + STARTUP_SHOW_AFTER_MS,
      quietSince === null ? null : quietSince + STARTUP_QUIET_MS
    ].filter((t): t is number => t !== null)
    return {
      visible,
      progress: visible ? progress : null,
      recheckAt: rechecks.length > 0 ? Math.min(...rechecks) : null,
      ended: false
    }
  }

  return { update }
}
