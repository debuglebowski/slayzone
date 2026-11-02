import { HubToComputerMethods } from '@slayzone/computer-transport/shared'

/** These metadata/control frames must remain usable to repair a connection and run reconciliation. */
const controls = new Set<string>([
  HubToComputerMethods.chatRequest,
  HubToComputerMethods.ping,
  HubToComputerMethods.computerShutdown,
  HubToComputerMethods.computerSetAllowedRoots,
  HubToComputerMethods.projectList,
  HubToComputerMethods.projectResolvePath,
  HubToComputerMethods.projectSetPath,
  HubToComputerMethods.projectForgetPath
])
export function createComputerChatCommandBarrier(opts: {
  recover(computerId: string): Promise<void>
  lifecycle(computerId: string): Promise<void>
}) {
  return async (computerId: string, method: string) => {
    if (controls.has(method)) return
    await opts.recover(computerId)
    await opts.lifecycle(computerId)
  }
}

/** One ordered reconnect/idle sweep per computer. Failed stages retry on the next tick. */
export function createComputerChatMaintenance(opts: {
  asOwner(computerId: string, work: () => Promise<void>): Promise<void>
  projects(computerId: string): Promise<void>
  recover(computerId: string): Promise<void>
  lifecycle(computerId: string): Promise<void>
  sessions(computerId: string): Promise<void>
  migrate(computerId: string): Promise<void>
}) {
  const pending = new Map<string, Promise<void>>()
  return {
    run(computerId: string): Promise<void> {
      const existing = pending.get(computerId)
      if (existing) return existing
      const work = Promise.resolve()
        .then(() =>
          opts.asOwner(computerId, async () => {
            await opts.projects(computerId)
            await opts.recover(computerId)
            await opts.lifecycle(computerId)
            await opts.sessions(computerId)
            await opts.migrate(computerId)
          })
        )
        .finally(() => {
          if (pending.get(computerId) === work) pending.delete(computerId)
        })
      pending.set(computerId, work)
      return work
    },
    async drain() {
      await Promise.allSettled([...pending.values()])
    }
  }
}
