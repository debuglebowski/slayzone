/**
 * The hub `pty.onData` subscription, narrowed to the sessions the hub must relay:
 * the terminals mounted here that are NOT on a direct link (docs/direct-link.md).
 * The hub asks a session's computer to stream through it only while someone
 * watches the session, so a terminal on the direct link takes the hub out of its
 * data path entirely.
 *
 * When the set changes, the new subscription opens first, and the old one closes
 * once the new one has started. No chunk falls between them, and PtyContext drops
 * the duplicates of the overlap.
 *
 * @module terminal/client/relay-subscription
 */

export interface RelaySubscriptionOptions {
  /** Open the hub subscription for exactly `sessionIds`; call `onStarted` once live. */
  open(sessionIds: string[], onStarted: () => void): { close(): void }
}

export interface RelaySubscription {
  set(sessionIds: readonly string[]): void
  close(): void
}

export function createRelaySubscription(opts: RelaySubscriptionOptions): RelaySubscription {
  let wanted: string[] = []
  let applied = ''
  let live: { close(): void } | null = null
  let starting: { close(): void } | null = null
  let scheduled = false
  let closed = false

  function apply(): void {
    scheduled = false
    if (closed) return
    const key = wanted.join('\u0000')
    if (key === applied) return
    applied = key
    starting?.close()
    starting = null
    if (wanted.length === 0) {
      live?.close()
      live = null
      return
    }
    let started = false
    const next = opts.open([...wanted], () => {
      if (started || closed || starting !== next) return
      started = true
      live?.close()
      live = next
      starting = null
    })
    starting = next
  }

  return {
    set(sessionIds) {
      wanted = [...new Set(sessionIds)].sort()
      if (!scheduled) {
        scheduled = true
        queueMicrotask(apply)
      }
    },
    close() {
      closed = true
      starting?.close()
      live?.close()
      starting = null
      live = null
    }
  }
}
