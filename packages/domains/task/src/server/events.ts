import { EventEmitter } from 'node:events'

interface TaskEventBase {
  taskId: string
  projectId: string
}

export interface TaskEventMap {
  'task:created': TaskEventBase
  'task:archived': TaskEventBase
  'task:unarchived': TaskEventBase
  'task:updated': TaskEventBase & { oldStatus?: string }
  'task:deleted': TaskEventBase
  'task:restored': TaskEventBase
  'task:tag-changed': TaskEventBase & { tagId?: string | null }
}

export interface AgentSessionsEventMap {
  /**
   * Emitted whenever the agent-session set for a task changes — a new spawn,
   * a confirmed conversation id, or a reset. Payload carries the task id so each
   * renderer refetches only its own session list. Mirrors the
   * `agent-prompts:changed` pattern (adapted to this module's object-payload
   * TypedEmitter).
   */
  'agent-sessions:changed': { taskId: string }
}

class TypedEmitter<M> extends EventEmitter {
  override emit<K extends keyof M & string>(event: K, payload: M[K]): boolean {
    return super.emit(event, payload)
  }
  override on<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): this {
    return super.on(event, listener)
  }
  override off<K extends keyof M & string>(event: K, listener: (payload: M[K]) => void): this {
    return super.off(event, listener)
  }
}

export const taskEvents = new TypedEmitter<TaskEventMap>()

/**
 * Domain event bus for agent-session lifecycle changes. Fired from the session
 * write paths (`recordConversation`, `bindSessionToTask`, the reset route); the
 * tRPC `agentSessions.onChanged` subscription wraps it so each renderer refetches
 * the affected task's session list.
 */
export const agentSessionsEvents = new TypedEmitter<AgentSessionsEventMap>()
