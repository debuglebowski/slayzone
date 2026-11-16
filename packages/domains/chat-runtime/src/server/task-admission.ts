/** Main-process revocation/admission; worker checks remain authoritative. */
export interface ChatTaskPermit {
  assert(): void
  release(): void
}
export interface ChatTaskAdmission {
  acquire(taskId: string): Promise<ChatTaskPermit>
}
export function createChatTaskAdmission(check: (taskId: string) => Promise<void>) {
  type Task = { generation: number; blocked: number; active: Set<Promise<void>> }
  const tasks = new Map<string, Task>()
  let closed = false
  const state = (id: string) => {
    let task = tasks.get(id)
    if (!task) {
      task = { generation: 0, blocked: 0, active: new Set() }
      tasks.set(id, task)
    }
    return task
  }
  const api: ChatTaskAdmission & {
    block(taskId: string): { ready: Promise<void>; release(): void }
    blocked(taskId: string): boolean
    busy(taskId: string): boolean
    close(): void
  } = {
    async acquire(taskId) {
      const task = state(taskId),
        generation = task.generation
      if (closed || task.blocked) throw new Error('Task work admission is closed')
      let finish: () => void = () => undefined
      const done = new Promise<void>((resolve) => {
        finish = resolve
      })
      task.active.add(done)
      let released = false
      const release = () => {
        if (!released) {
          released = true
          task.active.delete(done)
          finish()
        }
      }
      const assert = () => {
        if (closed || released || task.blocked || task.generation !== generation)
          throw new Error('Task work admission changed')
      }
      try {
        await check(taskId)
        assert()
        return { assert, release }
      } catch (error) {
        release()
        throw error
      }
    },
    block(taskId) {
      const task = state(taskId)
      task.generation++
      task.blocked++
      let released = false
      return {
        ready: Promise.all([...task.active]).then(() => undefined),
        release: () => {
          if (!released) {
            released = true
            task.blocked--
          }
        }
      }
    },
    busy: (taskId) => !!tasks.get(taskId)?.active.size,
    blocked: (taskId) => closed || !!state(taskId).blocked,
    close: () => {
      closed = true
      for (const task of tasks.values()) task.generation++
    }
  }
  return api
}
