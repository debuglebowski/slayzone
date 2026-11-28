import type { EventEmitter } from 'node:events'
import type { SlayzoneDb } from '@slayzone/platform'
import { SettingsService } from '@slayzone/settings-core/server'
import {
  setIdleCloseConfigGetter,
  startIdleChecker,
  touchTaskMainSession
} from '@slayzone/terminal/hub'
import { readIdleCloseConfig, type IdleCloseConfig } from './chat-idle-close.js'

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
  /** The current setting; disabled until the cache is warm (fails safe). */
  config: () => IdleCloseConfig
  /**
   * When the user last engaged with this task outside its agent's own view (the
   * browser panel). Computer chats have no hub-side session to touch, so the chat
   * idle-close re-check (`chatIdleCloseAllows`) reads this instead.
   */
  engagedAt: (taskId: string) => number | undefined
}

/** Engagement older than this can no longer keep any window open worth having. */
const ENGAGEMENT_RETAIN_MS = 24 * 3_600_000
const ENGAGEMENT_PRUNE_AT = 512

/**
 * Run idle-close (hibernation) in the process that owns the pty sessions — this
 * one since slice 9. Three parts, all of which must live here:
 *
 *  - the config getter `isHibernateEligible` reads (fails safe to disabled when
 *    unset);
 *  - the sweep that evaluates it every 10s (`startIdleChecker`), which also runs
 *    the silence-timer running→idle fallback for non-hook agents;
 *  - the browser panel's engagement touch. A web view's input never reaches the
 *    renderer DOM, so the client's browser host reports it, and the panel sends it
 *    here as `app.browserRelay.engaged` — emitted on `browserEvents` as `engaged`.
 *
 * All three were wired only in the Electron host, whose registry holds no
 * sessions. `9023df2fe` moved the getter here but left the sweep in the host, so
 * the feature stayed dead. Extracted from `composition.ts` so the wiring is
 * assertable — see `idle-close.test.ts`.
 *
 * Chats run on computers, which sweep them themselves against the same setting:
 * the handle's `config` / `engagedAt` back `chat.idlePolicy` and the `idle`
 * re-check of `chat.hibernateCheck` (composition.ts, chat-idle-close.ts).
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
  let warm = false
  const config = (): IdleCloseConfig =>
    warm
      ? readIdleCloseConfig((key) => settings.getCached(key))
      : { enabled: false, idleMs: 30 * 60_000 }
  const ready = settings.warmCache(IDLE_CLOSE_KEYS).then(
    () => {
      warm = true
      setIdleCloseConfigGetter(config)
    },
    () => {
      // Warm failed (transient DB error at boot) — leave the getter unset so the
      // sweep keeps failing safe rather than reading half a config.
    }
  )
  // Not gated on the warm: the sweep's silence-timer half needs no config.
  startIdleChecker()
  const engaged = new Map<string, number>()
  browserEvents.on('engaged', (payload: unknown) => {
    const taskId = (payload as { taskId?: unknown } | null)?.taskId
    if (typeof taskId !== 'string') return
    const now = Date.now()
    engaged.set(taskId, now)
    if (engaged.size > ENGAGEMENT_PRUNE_AT) {
      for (const [id, at] of engaged) if (now - at > ENGAGEMENT_RETAIN_MS) engaged.delete(id)
    }
    touchTaskMainSession(taskId)
  })
  return {
    ready,
    rewarm: () => settings.warmCache(IDLE_CLOSE_KEYS),
    config,
    engagedAt: (taskId) => engaged.get(taskId)
  }
}
