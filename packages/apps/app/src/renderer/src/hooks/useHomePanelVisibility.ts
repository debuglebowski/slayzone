import { useState, useEffect, useRef, useCallback } from 'react'

type HomePanel = 'kanban' | 'git' | 'editor' | 'processes' | 'tests' | 'automations'

export interface HomePanelState {
  visibility: Record<HomePanel, boolean>
  gitTab: string
}

const DEFAULTS: HomePanelState = {
  visibility: { kanban: true, git: false, editor: false, processes: false, tests: false, automations: false },
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

export function useHomePanelState(
  projectId: string
): [HomePanelState, (updater: (prev: HomePanelState) => HomePanelState) => void] {
  const [state, setState] = useState<HomePanelState>(DEFAULTS)
  const stateRef = useRef(state)
  stateRef.current = state
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<HomePanelState | null>(null)

  const flushSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (pendingRef.current) {
      window.api.settings.set(getKey(projectId), JSON.stringify(pendingRef.current))
      pendingRef.current = null
    }
  }, [projectId])

  // Load on mount / project change
  useEffect(() => {
    setState(DEFAULTS)
    window.api.settings.get(getKey(projectId)).then((value) => {
      if (value) {
        try { setState(parse(value)) } catch { /* use defaults */ }
      }
    })
  }, [projectId])

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

  const update = useCallback((updater: (prev: HomePanelState) => HomePanelState) => {
    const next = updater(stateRef.current)
    stateRef.current = next
    setState(next)
    pendingRef.current = next
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      pendingRef.current = null
      window.api.settings.set(getKey(projectId), JSON.stringify(next))
    }, 500)
  }, [projectId])

  return [state, update]
}
