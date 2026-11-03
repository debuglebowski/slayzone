import { useEffect, useState, useSyncExternalStore } from 'react'
import { StartupProgressCard } from '@slayzone/sidebar'
import { initQueuedCount, subscribeInitQueued } from '@slayzone/terminal/client'
import { useSubscription } from '@slayzone/transport/client'
import { useTRPC } from '../trpc'
import { paneHydrator } from './pane-hydration'
import { createStartupWatch, type StartupInputs, type StartupView } from './startup-progress'

const HIDDEN: StartupView = { visible: false, progress: null, recheckAt: null, ended: false }

/**
 * The startup watch as an external store: inputs go in, the view comes out, and the
 * watch's own rechecks (show-delay, quiet spell) run on its timer, not on renders.
 */
function createStartupStore() {
  const watch = createStartupWatch(Date.now())
  const listeners = new Set<() => void>()
  let inputs: StartupInputs | null = null
  let view = HIDDEN
  let timer: ReturnType<typeof setTimeout> | undefined
  const evaluate = (): void => {
    clearTimeout(timer)
    timer = undefined
    if (view.ended || !inputs) return
    view = watch.update(inputs, Date.now())
    for (const l of listeners) l()
    if (view.recheckAt !== null)
      timer = setTimeout(evaluate, Math.max(0, view.recheckAt - Date.now()))
  }
  return {
    setInputs(next: StartupInputs): void {
      inputs = next
      evaluate()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getView: (): StartupView => view,
    dispose(): void {
      clearTimeout(timer)
      timer = undefined
    }
  }
}

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
  const [store] = useState(createStartupStore)
  const [agents, setAgents] = useState<StartupInputs['agents']>(null)
  const view = useSyncExternalStore(store.subscribe, store.getView)
  const over = view.ended
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
    store.setInputs({ agents, panes, terminalsQueued })
  }, [store, agents, panes, terminalsQueued])
  useEffect(() => () => store.dispose(), [store])

  if (over || !view.visible || !view.progress) return null
  return <StartupProgressCard progress={view.progress} />
}
