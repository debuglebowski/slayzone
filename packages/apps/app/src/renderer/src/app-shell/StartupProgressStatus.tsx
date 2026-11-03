import { useEffect, useState, useSyncExternalStore } from 'react'
import { StartupProgressCard } from '@slayzone/sidebar'
import { initQueuedCount, subscribeInitQueued } from '@slayzone/terminal/client'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'
import { paneHydrator } from './pane-hydration'
import { createStartupWatch, type StartupInputs, type StartupView } from './startup-progress'

const HIDDEN: StartupView = { visible: false, progress: null, recheckAt: null, ended: false }

/**
 * The sidebar's startup card, fed live: tabs loading (`paneHydrator`), hidden
 * terminals waiting for their turn (`terminal-init-scheduler`), and agents starting
 * on the hub (`pty.onAgentStarts`). Its own component, rendered into the sidebar's
 * `statusSlot`, so each update re-renders only this — never the app around it,
 * which is exactly what must stay cheap while a workspace restores.
 *
 * Startup ends once (see `startup-progress.ts`); the hub subscription closes with it.
 */
export function StartupProgressStatus() {
  const trpc = useTRPC()
  const [watch] = useState(() => createStartupWatch(Date.now()))
  const [agents, setAgents] = useState<StartupInputs['agents']>(null)
  const [view, setView] = useState<StartupView>(HIDDEN)
  const [recheck, setRecheck] = useState(0)
  const [over, setOver] = useState(false)
  const panes = useSyncExternalStore(paneHydrator.subscribeProgress, paneHydrator.progress)
  const terminalsQueued = useSyncExternalStore(subscribeInitQueued, initQueuedCount)

  useSubscription(
    trpc.pty.onAgentStarts.subscriptionOptions(undefined, {
      enabled: !over,
      onData: (entries) => setAgents(entries),
      // A hub that cannot report agent starts: count tabs alone.
      onError: () => setAgents((prev) => prev ?? [])
    })
  )

  useEffect(() => {
    if (over) return
    const next = watch.update({ agents, panes, terminalsQueued }, Date.now())
    setView(next)
    if (next.ended) setOver(true)
    if (next.recheckAt === null) return
    const timer = setTimeout(() => setRecheck((n) => n + 1), Math.max(0, next.recheckAt - Date.now()))
    return () => clearTimeout(timer)
  }, [watch, agents, panes, terminalsQueued, recheck, over])

  if (over || !view.visible || !view.progress) return null
  return <StartupProgressCard progress={view.progress} />
}
