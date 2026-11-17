import type { AgentEvent, AgentExecution } from '@slayzone/terminal-contracts'
import type { ChatDriverContext } from './types'

/** Delivery acknowledgements name their own message; no execution owns them. */
function isAcknowledgement(event: AgentEvent): boolean {
  return (
    event.kind === 'user-replay' || event.kind === 'command-lifecycle' || event.kind === 'heartbeat'
  )
}

/** Capture ownership at dispatch time, never when a delayed callback completes. */
export function withExecution(
  ctx: ChatDriverContext,
  execution?: AgentExecution
): ChatDriverContext {
  if (!execution) return ctx
  const captured = { ...execution }
  return {
    ...ctx,
    execution: captured,
    emit: (event) =>
      ctx.emit(
        isAcknowledgement(event) ? event : { ...event, execution: event.execution ?? captured }
      )
  }
}
