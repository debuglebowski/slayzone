import { useState, useEffect, useRef, useCallback } from 'react'
import { useTRPCClient } from './trpc'

type HomePanel = 'kanban' | 'git' | 'editor' | 'processes' | 'tests' | 'automations'

export interface HomePanelState {
  visibility: Record<HomePanel, boolean>
  gitTab: string
}

const DEFAULTS: HomePanelState = {
  visibility: {
    kanban: true,
    git: false,
    editor: false,
    processes: false,
    tests: false,
    automations: false
  },
  gitTab: 'general'
}

function getKey(projectId: string): string {
  return `home-panels:${projectId}`
}

function parse(value: string): HomePanelState {
  const raw = JSON.parse(value)
  const result: HomePanelState = { ...DEFAULTS, visibility: { ...DEFAULTS.visibility } }
  if (raw.visibility && typeof raw.visibility === 'object') {
    for (const key of Object.keys(DEFAULTS.visibility) as HomePanel[]) {
      if (typeof raw.visibility[key] === 'boolean') result.visibility[key] = raw.visibility[key]
    }
  }
  if (typeof raw.gitTab === 'string') result.gitTab = raw.gitTab
  return result
}

/** Panels tagged with the project they belong to. */
interface OwnedPanelState {
  projectId: string
  state: HomePanelState
}

export function useHomePanelState(
  projectId: string
): [HomePanelState, (updater: (prev: HomePanelState) => HomePanelState) => void] {
  const trpcClient = useTRPCClient()
  const [owned, setOwned] = useState<OwnedPanelState>(() => ({ projectId, state: DEFAULTS }))
  // Another project's panels are never shown: until this project's load or first
  // edit lands, it is on the defaults.
  const state = owned.projectId === projectId ? owned.state : DEFAULTS
  // Mirrors the latest value set (every setOwned below writes it first), so
  // back-to-back updates chain without waiting for a render.
  const ownedRef = useRef(owned)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<HomePanelState | null>(null)

  const flushSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (pendingRef.current) {
      trpcClient.settings.set.mutate({
        key: getKey(projectId),
        value: JSON.stringify(pendingRef.current)
      })
      pendingRef.current = null
    }
  }, [projectId, trpcClient])

  // Load on mount / project change. A reply for a project no longer shown, or one
  // that lands after the user edited this project's panels while it loaded, is dropped.
  useEffect(() => {
    let stale = false
    const atStart = ownedRef.current
    void trpcClient.settings.get.query({ key: getKey(projectId) }).then((value) => {
      if (stale || !value) return
      const current = ownedRef.current
      if (current !== atStart && current.projectId === projectId) return
      try {
        const next = { projectId, state: parse(value) }
        ownedRef.current = next
        setOwned(next)
      } catch {
        /* use defaults */
      }
    })
    return () => {
      stale = true
    }
  }, [projectId, trpcClient])

  // Flush pending save on project change / unmount
  useEffect(() => {
    return () => flushSave()
  }, [flushSave])

  // Flush on hard reload / quit
  useEffect(() => {
    const handler = (): void => flushSave()
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [flushSave])

  const update = useCallback(
    (updater: (prev: HomePanelState) => HomePanelState) => {
      const current = ownedRef.current
      const next = updater(current.projectId === projectId ? current.state : DEFAULTS)
      const nextOwned = { projectId, state: next }
      ownedRef.current = nextOwned
      setOwned(nextOwned)
      pendingRef.current = next
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        pendingRef.current = null
        trpcClient.settings.set.mutate({ key: getKey(projectId), value: JSON.stringify(next) })
      }, 500)
    },
    [projectId, trpcClient]
  )

  return [state, update]
}
