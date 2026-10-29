import { getTrpcClient } from '../trpc'
import type { ClientErrorEventInput } from '@slayzone/types'

type DiagnosticsContext = Record<string, unknown>

let diagnosticsContext: DiagnosticsContext = {}

export function updateDiagnosticsContext(next: DiagnosticsContext): void {
  diagnosticsContext = { ...diagnosticsContext, ...next }
}

export function getDiagnosticsContext(): DiagnosticsContext {
  return { ...diagnosticsContext }
}

export function recordDiagnosticsTimeline(event: string, payload?: Record<string, unknown>): void {
  try {
    void getTrpcClient().diagnostics.recordClientEvent.mutate({
      event: `renderer.timeline.${event}`,
      level: 'info',
      message: event,
      payload: {
        ...payload,
        context: getDiagnosticsContext()
      }
    })
  } catch {
    // ignore diagnostics failures (incl. tRPC client not yet ready)
  }
}

/** One renderer diagnostics event under its own name (not the timeline prefix). */
export function recordRendererEvent(
  event: string,
  message: string,
  payload: Record<string, unknown>
): void {
  try {
    void getTrpcClient().diagnostics.recordClientEvent.mutate({
      event,
      level: 'info',
      message,
      payload
    })
  } catch {
    // ignore diagnostics failures (incl. tRPC client not yet ready)
  }
}

export function recordClientError(input: ClientErrorEventInput): void {
  try {
    void getTrpcClient().diagnostics.recordClientError.mutate(input)
  } catch {
    // ignore diagnostics failures before tRPC boot / during crash paths
  }
}
