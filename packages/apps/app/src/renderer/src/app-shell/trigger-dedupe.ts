/**
 * One user action that can arrive by two paths — the renderer's own keydown and the
 * native menu accelerator relayed from main — must run once. Whichever path delivers
 * first runs; the OTHER path's delivery within `windowMs` is that same press and is
 * dropped (once). A repeat on the same path is always a new press.
 */
/**
 * Pairing window for a keydown and its native-menu twin. The menu delivery is
 * relayed main → hub → renderer (tens of ms; more under main-thread load), so this
 * is generous; it only ever drops a cross-path delivery, never a repeat press.
 */
export const MENU_RELAY_DEDUPE_MS = 300

export type TriggerPath = 'keydown' | 'menu'

export interface TriggerDedupe {
  /** Whether to run this delivery. */
  accept(path: TriggerPath, now?: number): boolean
}

export function createTriggerDedupe(windowMs: number): TriggerDedupe {
  // The last accepted press still waiting for its other-path twin.
  let pending: { path: TriggerPath; at: number } | null = null
  return {
    accept(path, now = performance.now()) {
      if (pending && pending.path !== path && now - pending.at <= windowMs) {
        pending = null
        return false
      }
      pending = { path, at: now }
      return true
    }
  }
}
