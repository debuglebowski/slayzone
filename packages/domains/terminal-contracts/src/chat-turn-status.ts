/** Chat session state as the transport reports it (mirrors `ChatTerminalState`). */
export type ChatTurnState = 'not-spawned' | 'starting' | 'running' | 'idle' | 'error' | 'dead'

/**
 * Where a chat tab's turn stands — the read that tells "turn finished" from
 * "parked on a prompt". Both read `idle`; only the transport's pending-prompt
 * set and outbox know the difference. Answered by the computer that runs the tab.
 */
export interface ChatTurnStatus {
  state: ChatTurnState
  /** Running, parked on a prompt, or a message still on its way to the agent. */
  turnOpen: boolean
  /** `permission-request` ids the agent is blocked on, in arrival order. */
  pendingRequestIds: string[]
  /** Messages accepted by the outbox and not yet answered. */
  outboxInFlight: number
}
