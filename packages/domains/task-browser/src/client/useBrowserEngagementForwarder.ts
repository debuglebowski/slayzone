import { useEffect } from 'react'
import {
  getClientForHub,
  getHubIdForTask,
  useFederationOrNull,
  useHubRegistryStore
} from '@slayzone/transport/client'
import { BROWSER_CLIENT_KEY, getBrowserHost, useBrowserHostEvent } from './browser-host'

/** The slice of the hub's API this forwarder calls (the runtime client is untyped). */
interface EngagedClient {
  app: {
    browserRelay: {
      engaged: { mutate: (input: { taskId: string; clientKey: string }) => Promise<unknown> }
      present: {
        subscribe: (input: undefined, opts: { onError?: () => void }) => { unsubscribe: () => void }
      }
    }
  }
}

/**
 * Forward genuine user input in ANY of this device's web views — browser tabs and
 * web panels, whether or not a browser panel is mounted — to the hub that owns the
 * view's task (`app.browserRelay.engaged`). The hub's idle-close keeps that task's
 * agent awake (what the desktop bridge used to carry), and `slay browser` follows the
 * client used last. Mount ONCE per window, app-level.
 *
 * Electron main already throttles `engaged` per task.
 */
export function useBrowserEngagementForwarder(): void {
  // Tell every hub this device can host the browser panel (`app.browserRelay.present`),
  // so `slay browser` can tell "open the panel" from "no desktop app at all".
  const federation = useFederationOrNull()
  const hubIds = useHubRegistryStore((s) => s.hubs.map((h) => h.id).join('\n'))
  useEffect(() => {
    if (!getBrowserHost()) return
    const ids = hubIds ? hubIds.split('\n') : []
    const clients = new Set<unknown>()
    if (federation) for (const id of ids) clients.add(federation.resolve(id)?.ws.client)
    if (clients.size === 0 || !federation) clients.add(getClientForHub(undefined))
    clients.delete(undefined)
    const subs = [...clients].map((c) =>
      (c as EngagedClient).app.browserRelay.present.subscribe(undefined, {
        onError: () => {
          /* an older hub has no presence; its errors stay as they were */
        }
      })
    )
    return () => {
      for (const sub of subs) sub.unsubscribe()
    }
  }, [federation, hubIds])

  useBrowserHostEvent('engaged', ({ taskId }) => {
    if (!taskId) return
    const client = getClientForHub(getHubIdForTask(taskId)) as unknown as EngagedClient
    client.app.browserRelay.engaged.mutate({ taskId, clientKey: BROWSER_CLIENT_KEY }).catch(() => {
      /* best effort: a missed touch only shortens one idle window */
    })
  })
}
