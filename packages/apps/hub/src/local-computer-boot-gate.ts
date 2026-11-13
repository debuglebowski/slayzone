/**
 * The desktop's local computer enrolls a few seconds after its hub boots (the file
 * editor, a git panel, a task page restored at boot asks before then). A call that
 * needs a computer in that window WAITS for the local computer's first connect and
 * resolves again, rather than failing with "connect a computer" — and never falls
 * back to the hub's own disk (it cannot confine a path scope there, §9 Phase 7b).
 * Task paths, sessions and prompts read through it too (S6), so a task page opened
 * at boot shows "loading", never "connect it to start".
 *
 * Only a local computer registered here is waited for, and only during the BOOT
 * WINDOW: one deadline (`timeoutMs` from the gate's creation, at hub boot) shared by
 * every call. It closes on the local computer's first connect, on that deadline, or
 * on a reported start failure ({@link close}); from then on a computer that is not
 * usable is a real answer and nothing waits — a local computer that never comes
 * costs one wait in total, not `timeoutMs` per call.
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
  /** The boot window: the longest wait for the local computer's first connect, from boot. */
  timeoutMs: number
}

/** When to wait in {@link LocalComputerBootGate.settleWith}: what counts as "no computer". */
export interface BootUnanswered<T> {
  /** A result that a connected local computer could have answered differently. */
  unanswered?: (result: T) => boolean
  /** An error that only says the computer was not there (re-thrown when final). */
  offline?: (error: unknown) => boolean
}

export function createLocalComputerBootGate(deps: LocalComputerBootGateDeps) {
  let booted = deps.usable(deps.localComputerId)
  /** The boot window closed without a connect (deadline or a reported failure). */
  let closed = false
  let endWindow: (connected: boolean) => void = () => undefined
  /** Resolves when the window ends: true on the local computer's first connect. */
  const windowEnd: Promise<boolean> = booted
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => {
        endWindow = resolve
      })
  // One deadline from boot for every call (not one per call).
  const deadline = booted ? null : setTimeout(() => close(), deps.timeoutMs)
  deadline?.unref?.()
  const stop = deps.events.on('computer-connected', ({ computer }) => {
    if (computer.computerId !== deps.localComputerId) return
    booted = true
    stop()
    if (deadline) clearTimeout(deadline)
    endWindow(true)
  })
  if (booted) stop()

  function close(): void {
    if (booted || closed) return
    closed = true
    if (deadline) clearTimeout(deadline)
    endWindow(false)
  }

  /** Whether a call that found no computer should wait (the window is open). */
  async function waits(): Promise<boolean> {
    if (booted || closed) return false
    return deps.registered().catch(() => false)
  }

  async function settleWith<T>(work: () => Promise<T>, when: BootUnanswered<T>): Promise<T> {
    let first: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      first = { ok: true, value: await work() }
    } catch (error) {
      if (!when.offline?.(error)) throw error
      first = { ok: false, error }
    }
    const final = (): T => {
      if (first.ok) return first.value
      throw first.error
    }
    if (first.ok && !when.unanswered?.(first.value)) return first.value
    if (!(await waits())) return final()
    return (await windowEnd) ? work() : final()
  }

  return {
    /** Whether the local computer has connected since this hub booted. */
    get booted(): boolean {
      return booted
    },
    /** Whether the boot window is still open (calls that find no computer wait). */
    get booting(): boolean {
      return !booted && !closed
    },
    /**
     * Close the boot window now: the local computer is known not to be coming (its
     * supervisor reported a start failure). Waiting calls answer with what they have.
     */
    close(_reason?: string): void {
      close()
    },
    /**
     * `resolve` once; when it names no usable computer and the boot window is open,
     * once more after the local computer connects (or the first answer when the
     * window closes).
     */
    settle(resolve: () => Promise<string | null>): Promise<string | null> {
      return settleWith(resolve, {
        unanswered: (first) => first === null || !deps.usable(first)
      })
    },
    /**
     * Any computer-backed read (task paths, sessions, prompts): `work` once; when its
     * result is unanswered or it failed offline, and the boot window is open, once
     * more after the local computer connects (or the first outcome when the window
     * closes). Other errors propagate at once.
     */
    settleWith
  }
}

export type LocalComputerBootGate = ReturnType<typeof createLocalComputerBootGate>
