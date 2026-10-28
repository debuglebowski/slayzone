import type { EventEmitter } from 'node:events'
import type { SlayzoneDb } from '@slayzone/platform'
import { SettingsService } from '@slayzone/settings-core/server'
import {
  setIdleCloseConfigGetter,
  startIdleChecker,
  touchTaskMainSession
} from '@slayzone/terminal/server'

const IDLE_CLOSE_KEYS = [
  'terminal_auto_close_idle',
  'terminal_idle_close_value',
  'terminal_idle_close_unit'
]

export type IdleCloseHandle = {
  /** Settles once the settings cache is warm and the config getter is set. */
  ready: Promise<void>
  /** Re-read the idle-close settings (the test reset wipes the table). */
  rewarm: () => Promise<void>
}

/**
 * Run idle-close (hibernation) in the process that owns the pty sessions — this
 * one since slice 9. Three parts, all of which must live here:
 *
 *  - the config getter `isHibernateEligible` reads (fails safe to disabled when
 *    unset);
 *  - the sweep that evaluates it every 10s (`startIdleChecker`), which also runs
 *    the silence-timer running→idle fallback for non-hook agents;
 *  - the browser panel's engagement touch. A WebContentsView's input never
 *    reaches the renderer DOM, so the desktop reports it as a bare-taskId
 *    `engaged` browser event, relayed here over the desktop bridge.
 *
 * All three were wired only in the Electron host, whose registry holds no
 * sessions. `9023df2fe` moved the getter here but left the sweep in the host, so
 * the feature stayed dead. Extracted from `composition.ts` so the wiring is
 * assertable — see `idle-close.test.ts`.
 *
 * Reads through the SHARED `SettingsService` instance (one per db handle): the
 * settings router mutates that same instance and `set()` writes through for
 * warmed keys, so a UI toggle reaches this SYNC getter with no event or restart.
 */
export function wireIdleClose(
  db: SlayzoneDb,
  browserEvents: Pick<EventEmitter, 'on'>
): IdleCloseHandle {
  const settings = SettingsService.forDatabase(db)
  const ready = settings.warmCache(IDLE_CLOSE_KEYS).then(
    () => {
      setIdleCloseConfigGetter(() => {
        const value = Number(settings.getCached('terminal_idle_close_value')) || 30
        const unit = settings.getCached('terminal_idle_close_unit') || 'minutes'
        const unitMs = unit === 'seconds' ? 1_000 : unit === 'hours' ? 3_600_000 : 60_000
        return {
          // Raw `=== '1'` (NOT isLabEnabled, which defaults ON in dev) keeps it
          // strictly opt-in.
          enabled: settings.getCached('terminal_auto_close_idle') === '1',
          idleMs: value * unitMs
        }
      })
    },
    () => {
      // Warm failed (transient DB error at boot) — leave the getter unset so the
      // sweep keeps failing safe rather than reading half a config.
    }
  )
  // Not gated on the warm: the sweep's silence-timer half needs no config.
  startIdleChecker()
  browserEvents.on('engaged', (payload: unknown) => {
    const taskId = (payload as { taskId?: unknown } | null)?.taskId
    if (typeof taskId === 'string') touchTaskMainSession(taskId)
  })
  return { ready, rewarm: () => settings.warmCache(IDLE_CLOSE_KEYS) }
}
