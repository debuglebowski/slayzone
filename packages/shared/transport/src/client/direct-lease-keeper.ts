/**
 * Hold one direct-link lease for one target while it is wanted (docs/direct-link.md),
 * for any client: the desktop terminal, the mobile terminal, chat.
 *
 *  - `onChange(lease)` when a lease is acquired; `onChange(null)` when it is lost
 *    (closed, renewal refused, computer reconnected), when the holder reports it
 *    unusable (`lost()`), or on `stop()`. The holder then goes back to the hub relay.
 *  - It tries again shortly after a loss, after `retryMs` when the hub had nothing
 *    to offer, and at once when the computer reconnects or the holder wakes it
 *    (`wake`, e.g. its session started — a terminal mounts before its process runs).
 *
 * @module transport/client/direct-lease-keeper
 */
import type { DirectIssueTarget } from '../direct/router'
import type { DirectLease, DirectLinkManager } from './direct-link'

export interface DirectLeaseKeeperOptions {
  target: DirectIssueTarget
  manager: Pick<DirectLinkManager, 'acquire' | 'onComputerConnected'>
  onChange(lease: DirectLease | null): void
  wake?: (cb: () => void) => () => void
  /** After a relay answer. */
  retryMs?: number
  /** After a lease was lost. */
  lostRetryMs?: number
}

export interface DirectLeaseKeeper {
  /** The holder found the lease unusable (its stream ended or errored). */
  lost(): void
  stop(): void
}

export function keepDirectLease(opts: DirectLeaseKeeperOptions): DirectLeaseKeeper {
  const retryMs = opts.retryMs ?? 60_000
  const lostRetryMs = opts.lostRetryMs ?? 1_000
  let stopped = false
  let connecting = false
  let lease: DirectLease | null = null
  let offLost: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function schedule(ms: number): void {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = null
      void connect()
    }, ms)
  }

  function drop(retryAfterMs: number | null): void {
    if (!lease) {
      if (retryAfterMs !== null) schedule(retryAfterMs)
      return
    }
    const held = lease
    lease = null
    offLost?.()
    offLost = null
    held.release()
    opts.onChange(null)
    if (retryAfterMs !== null) schedule(retryAfterMs)
  }

  async function connect(): Promise<void> {
    if (stopped || connecting || lease) return
    connecting = true
    const got = await opts.manager.acquire(opts.target).catch(() => null)
    connecting = false
    if (stopped) {
      got?.release()
      return
    }
    if (!got) {
      schedule(retryMs)
      return
    }
    lease = got
    offLost = got.onLost(() => drop(lostRetryMs))
    opts.onChange(got)
  }

  const retryNow = (): void => {
    if (lease || stopped) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    void connect()
  }
  const offConnected = opts.manager.onComputerConnected(retryNow)
  const offWake = opts.wake?.(retryNow) ?? (() => undefined)
  void connect()

  return {
    lost: () => drop(lostRetryMs),
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      offConnected()
      offWake()
      drop(null)
    }
  }
}
