import { getTrpcClient } from '@slayzone/transport/client'

/**
 * Per-mount timing trace for the Terminal component's init path. Collects
 * named marks (ms offsets from init start) locally and ships ONE
 * `terminal.mount_timeline` diagnostics event when the mount settles — built
 * to answer "where does the time go between tab-open and the terminal being
 * live" without spraying a tRPC mutation per step.
 */
export interface MountTimeline {
  mark(name: string): void
  /** Emit the collected trace. `outcome` names how the mount settled
   *  (created / restored / reattach / error). Call once; later calls no-op. */
  flush(outcome: string): void
}

export function startMountTimeline(sessionId: string, mode: string | undefined): MountTimeline {
  const t0 = performance.now()
  const marks: Record<string, number> = {}
  let flushed = false
  return {
    mark(name) {
      marks[name] = Math.round(performance.now() - t0)
    },
    flush(outcome) {
      if (flushed) return
      flushed = true
      try {
        void getTrpcClient().diagnostics.recordClientEvent.mutate({
          event: 'terminal.mount_timeline',
          level: 'info',
          sessionId,
          message: outcome,
          payload: {
            mode,
            outcome,
            totalMs: Math.round(performance.now() - t0),
            marks
          }
        })
      } catch {
        // Diagnostics must never block terminal init.
      }
    }
  }
}
