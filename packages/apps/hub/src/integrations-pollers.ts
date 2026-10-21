import type { SlayzoneDb } from '@slayzone/platform'
import { hubIntegrationsEnabled } from '@slayzone/platform/hub-switch-refusal'
import {
  startSyncPoller as defaultStartSyncPoller,
  startDiscoveryPoller as defaultStartDiscoveryPoller
} from '@slayzone/integrations/server'

/**
 * Start the Linear/GitHub/Jira PULL-sync pollers (sync every 10 s, discovery every 60 s).
 *
 * v0.35.0's Electron host started both at boot. The slice-9 refactor moved push-on-edit
 * into the hub (`wireIntegrationPush`) but never moved these, so pull-sync silently
 * stopped for everyone. The hub owns the database, so the hub runs them — standalone and
 * supervised alike, against its own DB.
 *
 * Not started at all when the hub's integrations switch is off. Both timers are unref'd:
 * they must never be the reason the hub process stays alive.
 * `fns` is injectable so the wiring can be tested without a provider.
 */
export type IntegrationPollerFns = {
  startSyncPoller: typeof defaultStartSyncPoller
  startDiscoveryPoller: typeof defaultStartDiscoveryPoller
}

export function startIntegrationPollers(opts: {
  db: SlayzoneDb
  notifyTasksChanged: () => void
  fns?: Partial<IntegrationPollerFns>
}): { stop: () => void } {
  const {
    startSyncPoller = defaultStartSyncPoller,
    startDiscoveryPoller = defaultStartDiscoveryPoller
  } = opts.fns ?? {}

  const timers: NodeJS.Timeout[] = []
  // `SLAYZONE_HUB_ENABLE_INTEGRATIONS=0`: this hub makes no provider call, so the pollers
  // never exist (the same stance as `wireIntegrationPush`). Starting them would hit the
  // credential refusal and write a `denied` audit line every tick.
  if (!hubIntegrationsEnabled()) return { stop: () => {} }
  // One poller failing to start must not take the other (or the boot) down.
  const start = (label: string, run: () => NodeJS.Timeout): void => {
    try {
      const timer = run()
      timer.unref()
      timers.push(timer)
    } catch (err) {
      console.warn(
        `[hub] integration ${label} poller not started: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  start('sync', () => startSyncPoller(opts.db, opts.notifyTasksChanged))
  start('discovery', () => startDiscoveryPoller(opts.db, opts.notifyTasksChanged))

  return {
    stop: () => {
      for (const timer of timers.splice(0)) clearInterval(timer)
    }
  }
}
