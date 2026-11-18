/**
 * The computer's scope check for chat process controls (`chat.request` kinds
 * `control`, `control.prepare`, `control.renew`, `control.cancel`).
 *
 * A control reaches a live provider process directly, before any store or path-jail
 * readiness (`main.ts` runs it as an independent control). So it is admitted only when
 * the hub authorized exactly the task the control names: the request's actor carries a
 * TASK path scope (platform/path-scope) whose task is the control identity's. No scope,
 * a project scope, or another task's scope is refused by this computer's own policy.
 * The hub relay stamps the owner task's scope on every control frame
 * (chat-runtime `hub-relay.ts`, `controlScope`).
 *
 * @module computer/chat-control-scope
 */
import {
  chatProcessControlSchema,
  chatControlPreparationSchema
} from '@slayzone/chat-runtime/shared'
import {
  ComputerTransportErrorCodes,
  RpcError,
  type RequestActor
} from '@slayzone/computer-transport/shared'

/** The `chat.request` kinds that are process controls. */
const CONTROL_KINDS: ReadonlySet<string> = new Set([
  'control',
  'control.prepare',
  'control.cancel',
  'control.renew'
])

/** Whether a `chat.request`'s params are a process control. */
export function isChatControlRequest(params: unknown): boolean {
  return CONTROL_KINDS.has(String((params as { kind?: unknown } | null)?.kind))
}

/**
 * Parse a control request and refuse it unless `actor`'s path scope is the task it
 * names. Throws the schema's error for a malformed control, and
 * `RpcError(refusedByComputer, 'Chat control task scope mismatch')` for a scope that
 * is not exactly that task's.
 */
export function assertChatControlScope(actor: RequestActor, params: unknown): void {
  const request =
    (params as { kind: string }).kind === 'control'
      ? chatProcessControlSchema.parse(params)
      : chatControlPreparationSchema.parse(params)
  if (actor.pathScope?.kind !== 'task' || actor.pathScope.taskId !== request.identity.taskId)
    throw new RpcError(
      ComputerTransportErrorCodes.refusedByComputer,
      'Chat control task scope mismatch'
    )
}
