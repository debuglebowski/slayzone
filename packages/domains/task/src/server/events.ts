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
