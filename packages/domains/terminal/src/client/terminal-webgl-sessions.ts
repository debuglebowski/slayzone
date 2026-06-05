import type { DowngradeReason } from './webgl-loader'

// Once WebGL construction fails (driver blocklist, lost GPU), every subsequent
// terminal skips it and uses the DOM renderer — no repeated throw, no half-init.
let webglDisabled = false

export function isWebglDisabled(): boolean {
  return webglDisabled
}

export function markWebglDisabled(): void {
  webglDisabled = true
}

// Sessions where the WebGL renderer was swapped out for the DOM renderer by
// a detection signal (context-loss / frame-time / canary / manual). Scoped to
// the current renderer process — a reload re-attempts WebGL.
//
// Distinct from {@link webglDisabled}: that one is a *process-wide* latch for
// construction failures (driver blocklist), this is a *per-session* latch for
// post-construction misbehavior. Different scopes, different reasons.
export const downgradedSessions = new Set<string>()

// Sessions that have already emitted a `terminal.webgl_renderer_ok` telemetry
// event. Deduped so the downgrade-rate denominator counts sessions, not every
// WebGL (re)load — a forceCompat toggle or cache-reattach can re-run the load
// path within one session.
export const rendererOkReportedSessions = new Set<string>()

// Test-only registry: maps sessionId → the live `handleDowngrade` closure for
// that terminal. Exposed via `window.__slayzone_scrambleDetector` so the e2e
// suite can simulate a detector fire (downgrade + telemetry path) without
// touching real GPU state. Populated when initTerminal constructs handleDowngrade,
// cleared in the unmount cleanup. Production code never reads this — the
// detectors call handleDowngrade directly via the `onDowngrade` option.
export const fakeDowngradeRegistry = new Map<string, (reason: DowngradeReason) => void>()

if (typeof window !== 'undefined') {
  ;(
    window as unknown as {
      __slayzone_scrambleDetector: {
        fireDowngrade: (sessionId: string, reason: DowngradeReason) => boolean
        sessions: () => string[]
      }
    }
  ).__slayzone_scrambleDetector = {
    fireDowngrade: (sessionId, reason): boolean => {
      const fn = fakeDowngradeRegistry.get(sessionId)
      if (!fn) return false
      fn(reason)
      return true
    },
    sessions: (): string[] => Array.from(fakeDowngradeRegistry.keys())
  }
}
