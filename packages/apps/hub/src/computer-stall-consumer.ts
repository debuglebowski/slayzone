import {
  COMPUTER_EVENT_LOOP_STALL_EVENT_NAME,
  computerEventLoopStallPayloadSchema
} from '@slayzone/computer-transport/shared'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'

/**
 * Minimal slice of the hub computer gateway this consumer needs: the generic
 * computer→hub `event` notification. Structural so the unit test drives it with a
 * tiny fake (as `agent-hook-relay-consumer.ts`).
 */
export interface ComputerStallGateway {
  events: {
    on(
      event: 'event',
      listener: (payload: { computerId: string; name: string; payload?: unknown }) => void
    ): void
  }
}

/**
 * Record each computer's own main-thread stall (`computer/stall-report.ts`) as the
 * hub diagnostic `computer.event_loop_stall`, beside the hub's own
 * `server.event_loop_stall`. A frozen computer misses heartbeats and is dropped; this
 * names why. `computerId` is the gateway's authenticated connection id, never a
 * field of the payload. A malformed report is dropped, and nothing here may throw
 * into the gateway's event loop.
 */
export function attachComputerStallConsumer(
  gateway: ComputerStallGateway,
  record: (event: DiagnosticEvent) => void = recordDiagnosticEvent
): void {
  gateway.events.on('event', (evt) => {
    if (evt.name !== COMPUTER_EVENT_LOOP_STALL_EVENT_NAME) return
    const parsed = computerEventLoopStallPayloadSchema.safeParse(evt.payload)
    if (!parsed.success) return
    try {
      record({
        level: 'warn',
        source: 'server',
        event: 'computer.event_loop_stall',
        message: `computer main thread froze for ${String(parsed.data.durationMs)}ms`,
        payload: { computerId: evt.computerId, ...parsed.data }
      })
    } catch {
      // Best-effort: a diagnostic never destabilizes the gateway.
    }
  })
}
