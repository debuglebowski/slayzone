import { HubToComputerMethods } from '@slayzone/computer-transport/shared'

/** These metadata/control frames must remain usable to repair a connection and run reconciliation. */
const controls = new Set<string>([
  HubToComputerMethods.chatRequest,
  HubToComputerMethods.ping,
  HubToComputerMethods.computerShutdown,
  // Stopping existing work cannot create a competing writer. Keep these usable
  // while recovery is blocked so operators can safely reach host maintenance.
  // Gateway authentication, project access and session ownership still apply.
  HubToComputerMethods.ptyKill,
  HubToComputerMethods.procKill,
  HubToComputerMethods.ptyList,
  HubToComputerMethods.procList,
  HubToComputerMethods.ptyResize,
  HubToComputerMethods.ptyWarmList,
  HubToComputerMethods.ptyWarmKill,
  HubToComputerMethods.computerSetAllowedRoots,
  HubToComputerMethods.projectList,
  HubToComputerMethods.projectResolvePath,
  HubToComputerMethods.projectSetPath,
  HubToComputerMethods.projectForgetPath
])
/**
 * Native commands (pty/proc/fs/git) wait only for task lifecycle fences: a
 * paused or deleted task's work must be stopped on the computer before new work
 * is admitted. Delivery is per task: a task whose pause/delete cannot be
 * delivered refuses its own agents (`resolvePtyComputer`), not every task's. They deliberately do NOT wait for chat recovery. Chat history is
 * per conversation; one damaged conversation, or chat storage that cannot open,
 * must not take terminals, files and git down for every task on the computer.
 * Chat operations and agent placement (`resolvePtyComputer`) enforce recovery
 * for the tasks whose history depends on it.
 */
export function createComputerChatCommandBarrier(opts: {
  lifecycle(computerId: string): Promise<void>
}) {
  return async (computerId: string, method: string) => {
    if (controls.has(method)) return
    await opts.lifecycle(computerId)
  }
}

/**
 * One ordered reconnect/idle sweep per computer. Failed stages retry on the next tick.
 *
 * Only a reconnect forces recovery. A forced recovery starts a new recovery
 * generation, and every open chat reloads its whole history on a new generation —
 * so an idle tick reuses the recovered state (recovery itself re-runs after a
 * failure). A reconnect arriving while a run is in flight runs after it rather
 * than joining it: that run may already be past its recovery step.
 */
export function createComputerChatMaintenance(opts: {
  asOwner(computerId: string, work: () => Promise<void>): Promise<void>
  projects(computerId: string): Promise<void>
  recover(computerId: string, force: boolean): Promise<void>
  lifecycle(computerId: string): Promise<void>
  /**
   * Hand the computer what the hub still holds of its tasks' computer-only data
   * (robustness plan §9). After lifecycle: a deleted task's rows are skipped there.
   */
  handoff?(computerId: string): Promise<void>
  sessions(computerId: string): Promise<void>
  migrate(computerId: string): Promise<void>
  /**
   * Mirror the computer's Needs-attention faults. Independent of the stages above:
   * it runs even when one of them failed (that failure may be exactly what to show).
   */
  faults?(computerId: string): Promise<void>
}) {
  const pending = new Map<string, Promise<void>>()
  return {
    run(computerId: string, runOpts: { reconnect?: boolean } = {}): Promise<void> {
      const reconnect = runOpts.reconnect === true
      const existing = pending.get(computerId)
      if (existing && !reconnect) return existing
      const work = (existing ? existing.catch(() => undefined) : Promise.resolve())
        .then(() =>
          opts.asOwner(computerId, async () => {
            try {
              await opts.projects(computerId)
              await opts.recover(computerId, reconnect)
              await opts.lifecycle(computerId)
              await opts.handoff?.(computerId)
              await opts.sessions(computerId)
              await opts.migrate(computerId)
            } finally {
              await opts.faults?.(computerId).catch((error: unknown) => {
                console.error(
                  '[chat] could not refresh the computer’s Needs-attention list:',
                  error
                )
              })
            }
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
