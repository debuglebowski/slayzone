import type { AgentExecution } from '@slayzone/terminal-contracts'
import type { ChatDriverContext } from './types'

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
    emit: (event) => ctx.emit({ ...event, execution: event.execution ?? captured })
  }
}
