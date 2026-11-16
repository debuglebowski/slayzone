import { getClientForHub, getHubIdForTask } from '@slayzone/transport/client'
import { BROWSER_CLIENT_KEY, useBrowserHostEvent } from './browser-host'

/** The slice of the hub's API this forwarder calls (the runtime client is untyped). */
interface EngagedClient {
  app: {
    browserRelay: {
      engaged: { mutate: (input: { taskId: string; clientKey: string }) => Promise<unknown> }
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
  useBrowserHostEvent('engaged', ({ taskId }) => {
    if (!taskId) return
    const client = getClientForHub(getHubIdForTask(taskId)) as unknown as EngagedClient
    client.app.browserRelay.engaged.mutate({ taskId, clientKey: BROWSER_CLIENT_KEY }).catch(() => {
      /* best effort: a missed touch only shortens one idle window */
    })
  })
}
