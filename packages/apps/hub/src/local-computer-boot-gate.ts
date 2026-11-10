/**
 * The desktop's local computer enrolls a few seconds after its hub boots (the file
 * editor, a git panel or a task restored at boot asks before then). A call that
 * needs a computer in that window WAITS for the local computer's first connect and
 * resolves again, rather than failing with "connect a computer" — and never falls
 * back to the hub's own disk (it cannot confine a path scope there, §9 Phase 7b).
 *
 * Only a local computer registered here is waited for. Only the boot window: once the local computer has connected, a computer that is
 * not usable is a real answer (it went away), and nothing waits. A boot that never
 * completes gives up after `timeoutMs` with the first answer.
 *
 * @module hub/local-computer-boot-gate
 */
import type { TypedEventEmitter } from '@slayzone/computer-transport/shared'
import type { ComputerGatewayEvents } from '@slayzone/computer-transport/server'

export interface LocalComputerBootGateDeps {
  events: Pick<TypedEventEmitter<ComputerGatewayEvents>, 'on'>
  /** The desktop's co-spawned computer. */
  localComputerId: string
  /** Whether a computer is connected and usable now. */
  usable(computerId: string): boolean
  /**
   * Whether the local computer is registered on this hub (enrolled before, not
   * revoked): only then is it coming back. A hub it never enrolled with — or one
   * running without it — answers at once, as before.
   */
  registered(): Promise<boolean>
  /** Longest wait for the local computer's first connect. */
  timeoutMs: number
}

export function createLocalComputerBootGate(deps: LocalComputerBootGateDeps) {
  let booted = deps.usable(deps.localComputerId)
  let release: () => void = () => undefined
  const firstConnect = booted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        release = resolve
      })
  const stop = deps.events.on('computer-connected', ({ computer }) => {
    if (computer.computerId !== deps.localComputerId) return
    booted = true
    stop()
    release()
  })
  if (booted) stop()

  /** Resolves on the local computer's first connect, or false after the timeout. */
  const waitForBoot = (): Promise<boolean> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), deps.timeoutMs)
      timer.unref?.()
      void firstConnect.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })

  return {
    /** Whether the local computer has connected since this hub booted. */
    get booted(): boolean {
      return booted
    },
    /**
     * `resolve` once; when it names no usable computer and the local computer is
     * still booting, once more after it connects (or the first answer on timeout).
     */
    async settle(resolve: () => Promise<string | null>): Promise<string | null> {
      const first = await resolve()
      if (booted || (first !== null && deps.usable(first))) return first
      if (!(await deps.registered().catch(() => false))) return first
      return (await waitForBoot()) ? resolve() : first
    }
  }
}

export type LocalComputerBootGate = ReturnType<typeof createLocalComputerBootGate>
